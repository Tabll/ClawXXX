import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';

const SHA256_METADATA_HEADER = 'x-cos-meta-clawx-sha256';
const IMMUTABLE_CACHE_CONTROL = 'public,max-age=31536000,immutable';
const MUTABLE_CACHE_CONTROL = 'no-cache,no-store,must-revalidate';
const MUTABLE_CHANNELS = new Set(['alpha', 'beta', 'latest']);

export class TencentCosPublisher {
  constructor({ client, bucket, region, rootPrefix = 'clawxxx' }) {
    if (!client) throw new Error('Tencent COS client is required');
    if (!/^[a-z0-9][a-z0-9-]{1,62}-\d{5,}$/.test(bucket ?? '')) throw new Error('Invalid Tencent COS bucket');
    if (!/^[a-z]{2}(?:-[a-z0-9]+)+$/.test(region ?? '')) throw new Error('Invalid Tencent COS region');
    this.client = client;
    this.bucket = bucket;
    this.region = region;
    this.rootPrefix = normalizeRelativeKey(rootPrefix, { allowTrailingSlash: false });
  }

  publicBaseUrl() {
    return `https://${this.bucket}.cos.${this.region}.tencentcos.cn/${this.rootPrefix}/`;
  }

  async verifyBucket() {
    const location = await this.client.getBucketLocation(this.#bucketParams());
    const actualRegion = String(location.LocationConstraint ?? '').replace(/^cos\./, '');
    if (actualRegion !== this.region) throw new Error(`Tencent COS region mismatch: expected ${this.region}, got ${actualRegion || '<empty>'}`);
    const versioning = await this.client.getBucketVersioning(this.#bucketParams());
    const status = versioning.VersioningConfiguration?.Status ?? 'Disabled';
    if (status === 'Enabled') {
      throw new Error('Tencent COS bucket versioning must not be Enabled because immutable object overwrite protection would be ineffective');
    }
    return { bucket: this.bucket, region: this.region, versioning: status, publicBaseUrl: this.publicBaseUrl() };
  }

  async putImmutable(filePath, relativeKey, cacheControl = IMMUTABLE_CACHE_CONTROL) {
    const file = regularFile(filePath);
    const key = this.#key(relativeKey);
    const digest = await sha256File(file);
    const existing = await this.#headOrNull(key);
    if (existing) return this.#assertExistingImmutable(file, key, digest, existing);

    try {
      await this.#upload(file, key, {
        cacheControl,
        digest,
        forbidOverwrite: true,
      });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const raced = await this.#headOrNull(key);
      if (!raced) throw error;
      return this.#assertExistingImmutable(file, key, digest, raced);
    }
    const uploaded = await this.#headOrNull(key);
    if (!uploaded || header(uploaded, SHA256_METADATA_HEADER) !== digest) {
      throw new Error(`Tencent COS immutable upload verification failed: ${key}`);
    }
    return { action: 'uploaded', key, sha256: digest, size: statSync(file).size };
  }

  async putMutable(filePath, relativeKey, cacheControl = MUTABLE_CACHE_CONTROL) {
    const file = regularFile(filePath);
    const key = this.#key(relativeKey);
    const digest = await sha256File(file);
    await this.#upload(file, key, { cacheControl, digest, forbidOverwrite: false });
    const uploaded = await this.#headOrNull(key);
    if (!uploaded || header(uploaded, SHA256_METADATA_HEADER) !== digest) {
      throw new Error(`Tencent COS mutable upload verification failed: ${key}`);
    }
    return { action: 'uploaded', key, sha256: digest, size: statSync(file).size };
  }

  async putImmutableDirectory(sourceDirectory, relativePrefix) {
    const files = listRegularFiles(sourceDirectory);
    if (files.length === 0) throw new Error('Immutable Tencent COS directory is empty');
    const prefix = normalizeRelativeKey(relativePrefix, { allowTrailingSlash: false });
    const results = [];
    for (const file of files) {
      results.push(await this.putImmutable(file.absolutePath, `${prefix}/${file.relativePath}`));
    }
    return results;
  }

  async syncMutableChannel(sourceDirectory, channel) {
    if (!MUTABLE_CHANNELS.has(channel)) throw new Error(`Refusing to replace unsupported release channel: ${channel}`);
    const files = listRegularFiles(sourceDirectory).sort(metadataLast);
    if (files.length === 0) throw new Error('Mutable Tencent COS channel directory is empty');
    const desiredKeys = new Set();
    const uploaded = [];
    for (const file of files) {
      const relativeKey = `${channel}/${file.relativePath}`;
      desiredKeys.add(this.#key(relativeKey));
      uploaded.push(await this.putMutable(file.absolutePath, relativeKey));
    }
    const existing = await this.list(`${channel}/`);
    const stale = existing.filter(object => !desiredKeys.has(object.Key)).map(object => object.Key);
    await this.#deleteKeys(stale);
    return { channel, uploaded, deleted: stale };
  }

  async list(relativePrefix) {
    const prefix = this.#key(normalizeRelativeKey(relativePrefix, { allowTrailingSlash: true }));
    const objects = [];
    let marker;
    do {
      const page = await this.client.getBucket({
        ...this.#bucketParams(),
        Prefix: prefix,
        ...(marker ? { Marker: marker } : {}),
        MaxKeys: 1000,
      });
      objects.push(...(page.Contents ?? []));
      marker = page.IsTruncated === 'true' ? page.NextMarker : undefined;
      if (page.IsTruncated === 'true' && !marker) throw new Error('Tencent COS returned a truncated list without NextMarker');
    } while (marker);
    return objects.sort((left, right) => left.Key.localeCompare(right.Key));
  }

  async download(relativeKey, outputPath) {
    const output = resolve(outputPath);
    mkdirSync(dirname(output), { recursive: true });
    const stream = createWriteStream(output, { flags: 'wx', mode: 0o600 });
    try {
      await this.client.getObject({ ...this.#objectParams(this.#key(relativeKey)), Output: stream });
    } catch (error) {
      stream.destroy();
      rmSync(output, { force: true });
      throw error;
    }
    return { key: this.#key(relativeKey), output, sha256: await sha256File(output) };
  }

  async #assertExistingImmutable(file, key, digest, existing) {
    const metadataDigest = header(existing, SHA256_METADATA_HEADER);
    if (metadataDigest === digest) {
      return { action: 'unchanged', key, sha256: digest, size: statSync(file).size };
    }
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'clawx-cos-immutable-'));
    const existingFile = join(temporaryRoot, basename(key));
    try {
      const stream = createWriteStream(existingFile, { flags: 'wx', mode: 0o600 });
      await this.client.getObject({ ...this.#objectParams(key), Output: stream });
      const existingDigest = await sha256File(existingFile);
      if (existingDigest !== digest) throw new Error(`Immutable Tencent COS object differs: ${key}`);
      return { action: 'unchanged', key, sha256: digest, size: statSync(file).size };
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }

  async #upload(file, key, { cacheControl, digest, forbidOverwrite }) {
    const common = {
      ...this.#objectParams(key),
      CacheControl: cacheControl,
      ContentType: contentType(file),
      ACL: 'public-read',
      [SHA256_METADATA_HEADER]: digest,
    };
    if (forbidOverwrite) {
      const size = statSync(file).size;
      if (size > 5 * 1024 * 1024 * 1024) {
        throw new Error(`Immutable Tencent COS object exceeds the atomic single-PUT limit: ${key}`);
      }
      // uploadFile switches to multipart above SliceSize, and the SDK does not
      // carry x-cos-forbid-overwrite into CompleteMultipartUpload. A single
      // conditional PutObject keeps create-if-absent atomic at the COS service.
      await this.client.putObject({
        ...common,
        Body: createReadStream(file),
        ContentLength: size,
        Headers: { 'x-cos-forbid-overwrite': 'true' },
      });
      return;
    }
    await this.client.uploadFile({
      ...common,
      FilePath: file,
      SliceSize: 8 * 1024 * 1024,
    });
  }

  async #headOrNull(key) {
    try {
      return await this.client.headObject(this.#objectParams(key));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async #deleteKeys(keys) {
    for (let index = 0; index < keys.length; index += 1000) {
      const batch = keys.slice(index, index + 1000);
      if (batch.length === 0) continue;
      const result = await this.client.deleteMultipleObject({
        ...this.#bucketParams(),
        Objects: batch.map(Key => ({ Key })),
        Quiet: false,
      });
      if (result.Error?.length) throw new Error(`Tencent COS failed to delete ${result.Error.map(item => item.Key).join(', ')}`);
    }
  }

  #key(relativeKey) {
    return `${this.rootPrefix}/${normalizeRelativeKey(relativeKey, { allowTrailingSlash: true })}`;
  }

  #bucketParams() {
    return { Bucket: this.bucket, Region: this.region };
  }

  #objectParams(key) {
    return { ...this.#bucketParams(), Key: key };
  }
}

export function normalizeRelativeKey(value, options = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') || value.includes('\\')
    || /[\0-\x1f\x7f]/.test(value) || value.includes('//')) {
    throw new Error(`Unsafe Tencent COS object key: ${String(value)}`);
  }
  const trailingSlash = value.endsWith('/');
  const parts = value.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some(part => (
    part === '.' || part === '..' || !/^[A-Za-z0-9][A-Za-z0-9._+@=-]{0,255}$/.test(part)
  ))) throw new Error(`Unsafe Tencent COS object key: ${value}`);
  const normalized = parts.join('/');
  return options.allowTrailingSlash && trailingSlash ? `${normalized}/` : normalized;
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function listRegularFiles(sourceDirectory) {
  const root = resolve(sourceDirectory);
  if (!lstatSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);
  const results = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Tencent COS upload rejects symbolic links: ${absolutePath}`);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile()) results.push({ absolutePath, relativePath: relative(root, absolutePath).split(sep).join('/') });
      else throw new Error(`Tencent COS upload rejects non-regular files: ${absolutePath}`);
    }
  };
  visit(root);
  return results;
}

function regularFile(path) {
  const file = resolve(path);
  if (!lstatSync(file).isFile()) throw new Error(`Not a regular file: ${file}`);
  return file;
}

function header(result, name) {
  const headers = result?.headers ?? {};
  const match = Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase());
  return match ? String(headers[match]) : undefined;
}

function isMissing(error) {
  return error?.statusCode === 404 || ['NoSuchKey', 'NoSuchObject', 'NotFound'].includes(error?.code);
}

function isAlreadyExists(error) {
  return [409, 412].includes(error?.statusCode) || ['ObjectAlreadyExists', 'PreconditionFailed'].includes(error?.code);
}

function metadataLast(left, right) {
  const priority = path => (/\.ya?ml$/i.test(path) ? 2 : basename(path) === 'release-info.json' ? 3 : 1);
  return priority(left.relativePath) - priority(right.relativePath) || left.relativePath.localeCompare(right.relativePath);
}

function contentType(path) {
  const extension = extname(path).toLowerCase();
  return ({
    '.json': 'application/json',
    '.yml': 'application/yaml',
    '.yaml': 'application/yaml',
    '.sha256': 'text/plain; charset=utf-8',
    '.zst': 'application/zstd',
    '.zip': 'application/zip',
    '.dmg': 'application/x-apple-diskimage',
    '.exe': 'application/vnd.microsoft.portable-executable',
    '.deb': 'application/vnd.debian.binary-package',
    '.rpm': 'application/x-rpm',
    '.blockmap': 'application/octet-stream',
    '.appimage': 'application/octet-stream',
  })[extension] ?? 'application/octet-stream';
}

export const tencentCosCacheControl = Object.freeze({
  immutable: IMMUTABLE_CACHE_CONTROL,
  mutable: MUTABLE_CACHE_CONTROL,
});
