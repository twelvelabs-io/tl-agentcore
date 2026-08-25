# Neptune Analytics — the property-graph layer.
#
# One graph per stack, shared across all knowledge stores. Node keys are
# namespaced by KS (`ks_id` on every node) so the query path can filter
# to a single KB while cross-KS analytics stay possible on the same graph.
#
# Cost floor: 32 m-NCU × ~$0.16/m-NCU-hr ≈ $115/day, ≈ $3.6k/month. No
# serverless / scale-to-zero. Set `deletion_protection = false` here on
# purpose so `terraform destroy` in a dev sandbox doesn't get wedged —
# raise it for a real production stack.
#
# public_connectivity is on because our lambdas run outside a VPC. All
# calls to the data-plane endpoint are SigV4-signed against the
# neptune-graph service — no separate DB auth token, no VPC endpoint
# needed.

resource "aws_neptunegraph_graph" "this" {
  # `graph_name` is globally unique per region. Include the random stack
  # suffix so parallel stacks in the same account don't collide.
  graph_name          = replace(local.fqname, "_", "-")
  provisioned_memory  = var.graph_provisioned_memory
  replica_count       = 0
  public_connectivity = true
  deletion_protection = false
}

# ─── Bulk-import role ──────────────────────────────────────────────────
# Neptune Analytics's StartImportTask assumes this role to read the CSV /
# openCypher files we stage in the clips bucket. Trust policy limits the
# principal to the neptune-graph service.
data "aws_iam_policy_document" "graph_import_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["neptune-graph.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "graph_import" {
  name               = "${local.fqname}-graph-import"
  assume_role_policy = data.aws_iam_policy_document.graph_import_assume.json
}

data "aws_iam_policy_document" "graph_import_perms" {
  statement {
    sid       = "ReadStagedFiles"
    actions   = ["s3:GetObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.clips.arn, "${aws_s3_bucket.clips.arn}/graph/*"]
  }
}

resource "aws_iam_role_policy" "graph_import" {
  role   = aws_iam_role.graph_import.id
  policy = data.aws_iam_policy_document.graph_import_perms.json
}
