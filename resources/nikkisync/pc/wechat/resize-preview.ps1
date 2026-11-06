$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$inputStream = [Console]::OpenStandardInput()
$memory = New-Object System.IO.MemoryStream
$inputStream.CopyTo($memory)
if ($memory.Length -gt 16777216) { throw 'Input too large' }
$memory.Position = 0
$image = $null
$bitmap = $null
$graphics = $null
$output = $null
try {
    $image = [System.Drawing.Image]::FromStream($memory, $true, $true)
    if ($image.Width -lt 1 -or $image.Height -lt 1 -or ([long]$image.Width * $image.Height) -gt 40000000) { throw 'Image dimensions rejected' }
    if ($image.PropertyIdList -contains 274) {
        $orientation = [BitConverter]::ToUInt16($image.GetPropertyItem(274).Value, 0)
        $transforms = @{ 2 = 4; 3 = 2; 4 = 6; 5 = 5; 6 = 1; 7 = 7; 8 = 3 }
        if ($transforms.ContainsKey([int]$orientation)) { $image.RotateFlip([System.Drawing.RotateFlipType]$transforms[[int]$orientation]) }
    }
    $ratio = [Math]::Min(1.0, 960.0 / [Math]::Max($image.Width, $image.Height))
    $width = [Math]::Max(1, [int]([Math]::Round($image.Width * $ratio)))
    $height = [Math]::Max(1, [int]([Math]::Round($image.Height * $ratio)))
    # New bitmap contains only rendered pixels, never source EXIF or Nikki metadata tail.
    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.DrawImage($image, 0, 0, $width, $height)
    $output = New-Object System.IO.MemoryStream
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg'
    $parameters = New-Object System.Drawing.Imaging.EncoderParameters(1)
    try {
        $parameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]82)
        $bitmap.Save($output, $codec, $parameters)
    } finally { $parameters.Dispose() }
    if ($output.Length -gt 524288) { throw 'Preview too large' }
    $output.Position = 0
    $output.CopyTo([Console]::OpenStandardOutput())
} finally {
    if ($graphics) { $graphics.Dispose() }
    if ($bitmap) { $bitmap.Dispose() }
    if ($image) { $image.Dispose() }
    if ($output) { $output.Dispose() }
    $memory.Dispose()
}
