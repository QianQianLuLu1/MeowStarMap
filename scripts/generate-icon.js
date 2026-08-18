import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

async function generateIcon() {
  const svgPath = path.join(import.meta.dirname, '..', 'resources', 'icons', 'icon.svg')
  const icoPath = path.join(import.meta.dirname, '..', 'resources', 'icons', 'icon.ico')

  const pngBuffer = await sharp(svgPath).resize(256, 256).png().toBuffer()

  const icoBuffer = await pngToIco(pngBuffer)
  fs.writeFileSync(icoPath, icoBuffer)
  console.log(`Generated icon: ${icoPath}`)
}

generateIcon().catch((err) => {
  console.error('Failed to generate icon:', err)
  process.exit(1)
})
