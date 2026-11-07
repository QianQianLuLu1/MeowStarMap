$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$memory = New-Object System.IO.MemoryStream
[Console]::OpenStandardInput().CopyTo($memory)
if ($memory.Length -gt 2097152) { $memory.Dispose(); throw 'Icon input limit' }
$memory.Position = 0
$image = $null; $bitmap = $null; $graphics = $null; $output = $null
try {
    # GDI+ cannot decode WebP. Use the Windows imaging codecs for dictionary WebP icons.
    if ($memory.Length -ge 12) {
        $signature = $memory.GetBuffer()
        if ([Text.Encoding]::ASCII.GetString($signature, 0, 4) -eq 'RIFF' -and [Text.Encoding]::ASCII.GetString($signature, 8, 4) -eq 'WEBP') {
            Add-Type -AssemblyName PresentationCore
            $decoder = [Windows.Media.Imaging.BitmapDecoder]::Create($memory, [Windows.Media.Imaging.BitmapCreateOptions]::DelayCreation, [Windows.Media.Imaging.BitmapCacheOption]::OnDemand)
            $frame = $decoder.Frames[0]
            if (([long]$frame.PixelWidth * $frame.PixelHeight) -gt 40000000) { throw 'Icon pixel limit' }
            $ratio = [Math]::Min(1.0, 192.0 / [Math]::Max($frame.PixelWidth, $frame.PixelHeight))
            $source = $frame
            if ($ratio -lt 1) {
                $transform = New-Object Windows.Media.ScaleTransform($ratio, $ratio)
                $source = New-Object Windows.Media.Imaging.TransformedBitmap($frame, $transform)
            }
            $encoder = New-Object Windows.Media.Imaging.PngBitmapEncoder
            $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($source))
            $output = New-Object System.IO.MemoryStream
            $encoder.Save($output)
            if ($output.Length -gt 262144) { throw 'Icon output limit' }
            $output.Position = 0
            $output.CopyTo([Console]::OpenStandardOutput())
            return
        }
    }
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
