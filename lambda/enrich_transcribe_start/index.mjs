// enrich_transcribe_start — kick off an Amazon Transcribe job on a new
// asset's audio track.
//
// Invoked async by asset_profile after its ASSET# row is written.
// StartTranscriptionJob returns immediately; Transcribe streams the
// finished JSON to `s3://<clips>/transcripts/<asset_id>/<asset_id>.json`
// on completion, which the enrich_comprehend lambda picks up via S3
// notification and turns into MENTIONED_IN graph edges.
//
// Language: IdentifyLanguage=true lets Transcribe pick — cheaper than
// running language-detect ourselves and avoids the "brief is in EN,
// asset is in FR" mismatch.

import { TranscribeClient, StartTranscriptionJobCommand } from "@aws-sdk/client-transcribe";

const tr = new TranscribeClient({});
const CLIPS_BUCKET = process.env.CLIPS_BUCKET;

export const handler = async (event) => {
  const assetId = event?.asset_id;
  if (!assetId) {
    console.warn("enrich_transcribe_start: no asset_id in event");
    return { ok: false };
  }
  // Transcribe job names must be unique per account. We include the
  // asset_id (24-char hex) plus a short random suffix so a re-invocation
  // for the same asset doesn't collide with an in-flight or completed
  // job of the same name.
  const jobName = `${assetId}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await tr.send(new StartTranscriptionJobCommand({
      TranscriptionJobName: jobName,
      Media: { MediaFileUri: `s3://${CLIPS_BUCKET}/clips/${assetId}.mp4` },
      OutputBucketName: CLIPS_BUCKET,
      OutputKey: `transcripts/${assetId}/${assetId}.json`,
      IdentifyLanguage: true,
      Settings: {
        // Speaker labels would add a lot of noise for a pure entity-
        // extraction pipeline; skip.
        ShowSpeakerLabels: false,
      },
    }));
    console.log(`enrich_transcribe_start: ${assetId} → job ${jobName}`);
    return { ok: true, jobName };
  } catch (e) {
    console.warn(`enrich_transcribe_start: ${assetId} failed`, e);
    return { ok: false, error: String(e?.message || e) };
  }
};
