#!/usr/bin/env node
import CosModule from 'cos-nodejs-sdk-v5';
import { TencentCosPublisher, tencentCosCacheControl } from './kernel-runtime/lib/tencent-cos.mjs';

const COS = CosModule.default ?? CosModule;
const command = process.argv[2];
const args = new Map();
for (let index = 3; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);

const secretId = requiredEnvironment('TENCENTCLOUD_SECRET_ID');
const secretKey = requiredEnvironment('TENCENTCLOUD_SECRET_KEY');
const publisher = new TencentCosPublisher({
  client: new COS({ SecretId: secretId, SecretKey: secretKey }),
  bucket: requiredEnvironment('TENCENT_COS_BUCKET'),
  region: requiredEnvironment('TENCENT_COS_REGION'),
  rootPrefix: process.env.TENCENT_COS_ROOT_PREFIX ?? 'clawxxx',
});

let result;
if (command === 'verify-bucket') {
  result = await publisher.verifyBucket();
} else if (command === 'put-immutable') {
  result = await publisher.putImmutable(required('--file'), required('--key'), args.get('--cache-control') ?? tencentCosCacheControl.immutable);
} else if (command === 'put-mutable') {
  result = await publisher.putMutable(required('--file'), required('--key'), args.get('--cache-control') ?? tencentCosCacheControl.mutable);
} else if (command === 'put-directory-immutable') {
  result = await publisher.putImmutableDirectory(required('--source'), required('--prefix'));
} else if (command === 'sync-channel') {
  result = await publisher.syncMutableChannel(required('--source'), required('--channel'));
} else if (command === 'list') {
  result = await publisher.list(required('--prefix'));
} else if (command === 'get') {
  result = await publisher.download(required('--key'), required('--output'));
} else {
  throw new Error('Usage: tencent-cos.mjs <verify-bucket|put-immutable|put-mutable|put-directory-immutable|sync-channel|list|get> [options]');
}

process.stdout.write(`${JSON.stringify({ ok: true, command, result })}\n`);

function required(key) {
  const value = args.get(key);
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
