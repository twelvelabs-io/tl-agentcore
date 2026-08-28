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
  // Some source mp4s carry audio Transcribe refuses ("Failed to parse
  // audio file"): unusual codecs, or muxes where the audio track is
  // present but not one of Transcribe's supported combinations.
  // MediaConvert produces a `<asset_id>_normalized.mp4` sibling that
  // re-encodes to AAC and works reliably. Callers can retry with
  // `use_normalized: true` to route through that file.
  const useNormalized = event?.use_normalized === true;
  const mediaKey = useNormalized
    ? `clips/${assetId}_normalized.mp4`
    : `clips/${assetId}.mp4`;
  // Transcribe job names must be unique per account. We include the
  // asset_id (24-char hex) plus a short random suffix so a re-invocation
  // for the same asset doesn't collide with an in-flight or completed
  // job of the same name.
  const suffix = Math.random().toString(36).slice(2, 8);
  const jobName = useNormalized
    ? `${assetId}-norm-${suffix}`
    : `${assetId}-${suffix}`;
  try {
    await tr.send(new StartTranscriptionJobCommand({
      TranscriptionJobName: jobName,
      Media: { MediaFileUri: `s3://${CLIPS_BUCKET}/${mediaKey}` },
      OutputBucketName: CLIPS_BUCKET,
      OutputKey: `transcripts/${assetId}/${assetId}.json`,
      IdentifyLanguage: true,
      Settings: {
        // Speaker labels would add a lot of noise for a pure entity-
        // extraction pipeline; skip.
        ShowSpeakerLabels: false,
      },
    }));
    console.log(`enrich_transcribe_start: ${assetId}${useNormalized ? " (normalized)" : ""} → job ${jobName}`);
    return { ok: true, jobName };
  } catch (e) {
    console.warn(`enrich_transcribe_start: ${assetId} failed`, e);
    return { ok: false, error: String(e?.message || e) };
  }
};
