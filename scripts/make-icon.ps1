# assets/icon.png (256px), assets/tray.png (32px), assets/badge.png (16px 빨간 점) 생성
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root 'assets'
New-Item -ItemType Directory -Force $assets | Out-Null

function New-AppIcon([int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect,
    ([System.Drawing.Color]::FromArgb(255, 254, 218, 117)),
    ([System.Drawing.Color]::FromArgb(255, 131, 58, 180)), 45
  $blend = New-Object System.Drawing.Drawing2D.ColorBlend 3
  $blend.Colors = @(
    [System.Drawing.Color]::FromArgb(255, 254, 218, 117),
    [System.Drawing.Color]::FromArgb(255, 214, 41, 118),
    [System.Drawing.Color]::FromArgb(255, 131, 58, 180))
  $blend.Positions = @(0.0, 0.5, 1.0)
  $brush.InterpolationColors = $blend
  # 둥근 사각형 배경
  $r = [int]($size * 0.24)
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc(0, 0, $r, $r, 180, 90)
  $p.AddArc($size - $r - 1, 0, $r, $r, 270, 90)
  $p.AddArc($size - $r - 1, $size - $r - 1, $r, $r, 0, 90)
  $p.AddArc(0, $size - $r - 1, $r, $r, 90, 90)
  $p.CloseFigure()
  $g.FillPath($brush, $p)
  # 말풍선
  $white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
  $m = $size * 0.2
  $g.FillEllipse($white, $m, $m, $size - 2 * $m, ($size - 2 * $m) * 0.85)
  $tail = @(
    (New-Object System.Drawing.PointF ($size * 0.28), ($size * 0.62)),
    (New-Object System.Drawing.PointF ($size * 0.22), ($size * 0.82)),
    (New-Object System.Drawing.PointF ($size * 0.45), ($size * 0.70)))
  $g.FillPolygon($white, $tail)
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

New-AppIcon 256 (Join-Path $assets 'icon.png')
New-AppIcon 32 (Join-Path $assets 'tray.png')

# 작업표시줄 오버레이용 빨간 점
$b = [System.Drawing.Bitmap]::new(16, 16)
$g = [System.Drawing.Graphics]::FromImage($b)
$g.SmoothingMode = 'AntiAlias'
$g.FillEllipse([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 255, 59, 48)), 1, 1, 14, 14)
$g.Dispose()
$b.Save((Join-Path $assets 'badge.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$b.Dispose()
Write-Output "icons written to $assets"

