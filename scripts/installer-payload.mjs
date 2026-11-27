import fs from 'node:fs'

function writeAll(fd, buffer) {
  let offset = 0
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset)
    if (written <= 0) throw new Error('写入安装器失败')
    offset += written
  }
}

export function embedPayload(targetExe, payloadFile) {
  const manifestFile = `${payloadFile}.json`
  if (!fs.existsSync(manifestFile)) {
    throw new Error(`缺少载荷清单: ${manifestFile}`)
  }
  const manifest = fs.readFileSync(manifestFile)
  const tempExe = `${targetExe}.embedding`
  fs.copyFileSync(targetExe, tempExe)
  let out
  let input
  let failure
  try {
    out = fs.openSync(tempExe, 'a')
    input = fs.openSync(payloadFile, 'r')
    const size = fs.fstatSync(input).size
    const buffer = Buffer.allocUnsafe(8 * 1024 * 1024)
    let position = 0
    while (position < size) {
      const read = fs.readSync(input, buffer, 0, Math.min(buffer.length, size - position), position)
      if (read <= 0) throw new Error(`读取载荷失败: ${payloadFile}`)
      writeAll(out, buffer.subarray(0, read))
      position += read
    }
    writeAll(out, manifest)
    const footer = Buffer.alloc(24)
    footer.writeBigUInt64LE(BigInt(size), 0)
    footer.writeBigUInt64LE(BigInt(manifest.length), 8)
    footer.write('MEOWPAY1', 16, 'ascii')
    writeAll(out, footer)
  } catch (err) {
    failure = err
  } finally {
    for (const fd of [input, out]) {
      if (fd === undefined) continue
      try {
        fs.closeSync(fd)
      } catch (err) {
        failure ??= err
      }
    }
  }
  if (failure) {
    fs.rmSync(tempExe, { force: true })
    throw failure
  }
  fs.renameSync(tempExe, targetExe)
}
