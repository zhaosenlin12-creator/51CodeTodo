$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$fixturePath = Join-Path $PSScriptRoot '..\src-tauri\tests\fixtures\local-chat.png'
$bitmap = [System.Drawing.Bitmap]::new(900, 900)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$font = [System.Drawing.Font]::new('Microsoft YaHei', 28, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
try {
    $graphics.Clear([System.Drawing.Color]::White)
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $graphics.DrawString('星河示例客户', $font, [System.Drawing.Brushes]::Black, 24, 24)
    $graphics.DrawString('星期五 14:56', $font, [System.Drawing.Brushes]::Gray, 340, 220)
    $graphics.FillRectangle([System.Drawing.Brushes]::WhiteSmoke, 85, 310, 360, 150)
    $graphics.DrawString('示例图片说明', $font, [System.Drawing.Brushes]::Black, 110, 360)
    $graphics.DrawString('昨天 10:25', $font, [System.Drawing.Brushes]::Gray, 340, 560)
    $graphics.FillRectangle([System.Drawing.Brushes]::WhiteSmoke, 85, 635, 710, 130)
    $graphics.DrawString("请准备一份测试说明，`n时间待确认。", $font, [System.Drawing.Brushes]::Black, 110, 655)
    $bitmap.Save($fixturePath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally { $font.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
