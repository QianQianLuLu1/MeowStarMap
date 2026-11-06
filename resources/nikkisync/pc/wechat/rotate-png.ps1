param([ValidateSet(90,180,270)][int]$Rotation)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$memory = New-Object System.IO.MemoryStream
[Console]::OpenStandardInput().CopyTo($memory)
if ($memory.Length -gt 16777216) { $memory.Dispose(); throw 'Image limit' }
$memory.Position = 0
$image = $null; $bitmap = $null; $graphics = $null; $output = $null
try {
    $image = [System.Drawing.Image]::FromStream($memory, $true, $true)
    if ($image.RawFormat.Guid -ne [System.Drawing.Imaging.ImageFormat]::Png.Guid -or ([long]$image.Width * $image.Height) -gt 40000000) { throw 'PNG dimensions rejected' }
    if ([System.Drawing.Image]::GetPixelFormatSize($image.PixelFormat) -gt 32) { throw 'High bit-depth PNG requires a lossless high bit-depth encoder' }
    if ($image.PropertyIdList -contains 274) {
        $orientation = [BitConverter]::ToUInt16($image.GetPropertyItem(274).Value, 0)
        $transforms = @{ 2 = 4; 3 = 2; 4 = 6; 5 = 5; 6 = 1; 7 = 7; 8 = 3 }
        if ($transforms.ContainsKey([int]$orientation)) { $image.RotateFlip([System.Drawing.RotateFlipType]$transforms[[int]$orientation]) }
    }
    $bitmap = New-Object System.Drawing.Bitmap($image.Width, $image.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb))
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.DrawImageUnscaled($image, 0, 0)
    $graphics.Dispose(); $graphics = $null
    $bitmap.RotateFlip([System.Drawing.RotateFlipType]($Rotation / 90))
    $output = New-Object System.IO.MemoryStream
    $bitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)
    if ($output.Length -gt 16777216) { throw 'Output limit' }
    $output.Position = 0
    $output.CopyTo([Console]::OpenStandardOutput())
} finally {
    if ($graphics) { $graphics.Dispose() }
    if ($bitmap) { $bitmap.Dispose() }
    if ($image) { $image.Dispose() }
    if ($output) { $output.Dispose() }
    $memory.Dispose()
}
