import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporaryFile = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(temporaryFile, 'wx', 0o600);
    fs.writeFileSync(fileDescriptor, JSON.stringify(value, null, 2));
    fs.fsyncSync(fileDescriptor); fs.closeSync(fileDescriptor); fileDescriptor = undefined;
    // Only valid JSON can replace the last known good backup.
    if (fs.existsSync(file)) {
      try {
        JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.copyFileSync(file, `${file}.bak`);
        fs.chmodSync(`${file}.bak`, 0o600);
      } catch {}
    }
    fs.renameSync(temporaryFile, file);
    fs.chmodSync(file, 0o600);
  } finally {
    if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
    if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
  }
}

export function readJsonWithBackup(file, fallback) {
  if (!fs.existsSync(file) && !fs.existsSync(`${file}.bak`)) return { value: structuredClone(fallback), recovered: false };
  for (const [target, recovered] of [[file, false], [`${file}.bak`, true]]) {
    try {
      const value = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      return { value, recovered };
    } catch {}
  }
  // Do not overwrite unreadable user history with a silent empty reset.
  throw Object.assign(new Error('本地记录与备份均无法读取，请保留文件后检查。'), { code: 'STATE_CORRUPT' });
}
