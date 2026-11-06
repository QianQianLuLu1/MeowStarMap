$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$memory = New-Object System.IO.MemoryStream
[Console]::OpenStandardInput().CopyTo($memory)
if ($memory.Length -gt 2097152) { $memory.Dispose(); throw 'Icon input limit' }
$memory.Position = 0
$image = $null; $bitmap = $null; $graphics = $null; $output = $null
try {
    $image = [System.Drawing.Image]::FromStream($memory, $true, $true)
    if (([long]$image.Width * $image.Height) -gt 40000000) { throw 'Icon pixel limit' }
    $ratio = [Math]::Min(1.0, 192.0 / [Math]::Max($image.Width, $image.Height))
    $width = [Math]::Max(1, [int][Math]::Round($image.Width * $ratio))
    $height = [Math]::Max(1, [int][Math]::Round($image.Height * $ratio))
    $bitmap = New-Object System.Drawing.Bitmap($width, $height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb))
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.DrawImage($image, 0, 0, $width, $height)
    $output = New-Object System.IO.MemoryStream
    $bitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)
    if ($output.Length -gt 262144) { throw 'Icon output limit' }
    $output.Position = 0
    $output.CopyTo([Console]::OpenStandardOutput())
} finally {
    if ($graphics) { $graphics.Dispose() }
    if ($bitmap) { $bitmap.Dispose() }
    if ($image) { $image.Dispose() }
    if ($output) { $output.Dispose() }
    $memory.Dispose()
}
