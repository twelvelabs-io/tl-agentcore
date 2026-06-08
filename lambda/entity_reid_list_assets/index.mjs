// entity_reid_list_assets — Step Functions Task: enumerate cached assets
// for a knowledge_store_id, returning per-asset records the Map iterator
// will hand to invoke_async + embed_patches.
//
// Async-endpoint flavor (no S3 staging here — invoke_async Lambda PutObjects
// the request body itself). We only need to give the iterator everything
// invoke_async needs to construct a valid SageMaker async invocation:
//
//   {
//     "asset_id":     "6a09...",
//     "video_s3_uri": "s3://<clips>/clips/<asset>.mp4",
//     "request":      { "text_prompt": "person.", "fps": 2.0 },
//     "async_in_uri": "s3://<clips>/async-in/<exec>/<asset>/in.json"
//   }
//
// Output S3 URI isn't predicted here — SageMaker generates it and we read
// it from the InvokeEndpointAsync response inside invoke_async.

import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});

const KB_CACHE_TABLE = process.env.KB_CACHE_TABLE;
const CLIPS_BUCKET   = process.env.CLIPS_BUCKET_NAME;

export const handler = async (event) => {
  const { ks_id, execution_name, text_prompt = "person.", fps = 2.0, limit } = event || {};
  if (!ks_id) throw new Error("ks_id required");
  if (!execution_name) throw new Error("execution_name required");
  if (!KB_CACHE_TABLE) throw new Error("KB_CACHE_TABLE env var required");
  if (!CLIPS_BUCKET)   throw new Error("CLIPS_BUCKET_NAME env var required");

  const assetIds = [];
  let exclusiveStartKey;
  do {
    const resp = await ddb.send(new QueryCommand({
      TableName: KB_CACHE_TABLE,
      KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
      ExpressionAttributeValues: { ":p": { S: `ks#${ks_id}` }, ":s": { S: "ASSET#" } },
      ProjectionExpression: "asset_id",
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const item of resp.Items || []) {
      const aid = item?.asset_id?.S;
      if (aid) assetIds.push(aid);
      if (limit && assetIds.length >= limit) break;
    }
    exclusiveStartKey = resp.LastEvaluatedKey;
    if (limit && assetIds.length >= limit) break;
  } while (exclusiveStartKey);

  if (!assetIds.length) {
    return { ks_id, execution_name, assets: [], warning: "kb_cache empty for this ks_id" };
  }

  const request = { text_prompt, fps };
  const assets = assetIds.map((asset_id) => ({
    asset_id,
    video_s3_uri: `s3://${CLIPS_BUCKET}/clips/${asset_id}.mp4`,
    request,
    async_in_uri: `s3://${CLIPS_BUCKET}/async-in/${execution_name}/${asset_id}/in.json`,
  }));
  return { ks_id, execution_name, assets };
};
