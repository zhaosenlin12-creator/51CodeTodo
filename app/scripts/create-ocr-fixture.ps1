$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$fixtureDirectory = Join-Path $PSScriptRoot '..\src-tauri\tests\fixtures'
New-Item -ItemType Directory -Path $fixtureDirectory -Force | Out-Null
$bitmap = [System.Drawing.Bitmap]::new(800, 180)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$font = [System.Drawing.Font]::new('Microsoft YaHei', 30, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
try {
    $graphics.Clear([System.Drawing.Color]::White)
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $graphics.DrawString("示例客户`n周五交付 12345", $font, [System.Drawing.Brushes]::Black, 30, 25)
    $bitmap.Save((Join-Path $fixtureDirectory 'local-ocr.png'), [System.Drawing.Imaging.ImageFormat]::Png)
} finally { $font.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
