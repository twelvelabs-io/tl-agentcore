# MediaConvert — transcode every uploaded MP4 into an HLS bundle so the
# browser's ChannelPlayer can stream it from CloudFront /hls/* without any
# TwelveLabs CDN involvement.
#
# Output layout:
#   s3://<clips>/hls/<asset_id>/master.m3u8
#                              /index_1.m3u8 + .ts segments
#                              /thumb_000001.jpg (representative still)
#
# Jobs are kicked off by embed_clip_start on POST /upload/embed and run
# asynchronously. embed_clip_finalize_hls (S3-triggered on hls/.../master.m3u8)
# stamps the asset row from "pending" to "ready" once the manifest lands.

data "aws_iam_policy_document" "mc_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["mediaconvert.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "mediaconvert" {
  name               = "${local.fqname}-mediaconvert"
  assume_role_policy = data.aws_iam_policy_document.mc_assume.json
}

data "aws_iam_policy_document" "mc_perms" {
  statement {
    sid     = "ClipsRW"
    actions = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
    resources = [
      aws_s3_bucket.clips.arn,
      "${aws_s3_bucket.clips.arn}/*",
    ]
  }
}

resource "aws_iam_role_policy" "mediaconvert" {
  role   = aws_iam_role.mediaconvert.id
  policy = data.aws_iam_policy_document.mc_perms.json
}
