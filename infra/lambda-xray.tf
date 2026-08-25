# X-Ray daemon write access for every lambda role in the stack. Paired
# with `tracing_config { mode = "Active" }` on each aws_lambda_function
# — without both, traces are captured on the AWS side but the lambda
# process can't write segments to X-Ray.
#
# Kept in one file so adding a new lambda is: (1) declare its role,
# (2) add its role name to `local.lambda_role_names` here, and X-Ray
# is wired in automatically alongside the basic-exec attachment.

locals {
  lambda_role_names = {
    asset_profile       = aws_iam_role.asset_profile.name
    ks_rollup           = aws_iam_role.ks_rollup.name
    hls_finalize        = aws_iam_role.hls_finalize.name
    kb_admin            = aws_iam_role.kb_admin.name
    kb_graph            = aws_iam_role.kb_graph.name
    index_faces         = aws_iam_role.index_faces.name
    settings            = aws_iam_role.settings.name
    stitch              = aws_iam_role.stitch.name
    users               = aws_iam_role.users.name
    presign_upload          = aws_iam_role.presign_upload.name
    embed_clip_start        = aws_iam_role.embed_clip_start.name
    embed_clip_finalize     = aws_iam_role.embed_clip_finalize.name
    enrich_transcribe_start = aws_iam_role.enrich_transcribe_start.name
    enrich_comprehend       = aws_iam_role.enrich_comprehend.name
  }
}

resource "aws_iam_role_policy_attachment" "lambda_xray" {
  for_each   = local.lambda_role_names
  role       = each.value
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}
