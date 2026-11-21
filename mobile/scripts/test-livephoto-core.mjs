import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = 'app/nikkisync/mobile/media/live';
const names = ['QuarterTurn', 'LivePhotoProfile', 'JpegSegments', 'MotionXmp',
  'VivoLegacyMetadata', 'MotionContainer', 'MotionContainerVerifier'];
const files = names.map(n => path.join(mobile, 'app/src/main/java', pkg, `${n}.java`));
files.push(path.join(mobile,'app/src/main/java/app/nikkisync/mobile/util/ByteStreams.java'));
files.push(path.join(mobile, 'app/src/test/java', pkg, 'LivePhotoCoreChecks.java'));
files.push(path.join(mobile, 'app/src/test/java', pkg, 'LargeMotionContainerChecks.java'));
for (const file of files) assert.ok(existsSync(file), `Live Photo behavior not implemented: ${path.basename(file)}`);
const out = mkdtempSync(path.join(tmpdir(), 'nikkisync-live-test-'));
try {
  for (const [cmd, args] of [
    ['javac', ['--release', '17', '-encoding', 'UTF-8', '-d', out, ...files]],
    ['java', ['-ea', '-cp', out, 'app.nikkisync.mobile.media.live.LivePhotoCoreChecks']],
    ['java', ['-Xmx32m', '-ea', '-cp', out, 'app.nikkisync.mobile.media.live.LargeMotionContainerChecks', ...process.argv.slice(2)]]
  ]) {
    const result = spawnSync(cmd, args, {stdio: 'inherit'});
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${cmd} Live Photo checks failed`);
  }
} finally {
  rmSync(out, {recursive: true, force: true});
}
