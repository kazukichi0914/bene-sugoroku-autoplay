param([string]$OutDir = (Join-Path $PSScriptRoot "..\icons"))
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force $OutDir | Out-Null

function RoundRect($x, $y, $w, $h, $r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

foreach ($s in 16, 32, 48, 128) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $u = $s / 128.0

  # board background
  $bg = RoundRect 0 0 ($s - 1) ($s - 1) (24 * $u)
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(46, 160, 90))), $bg)

  # board squares (large sizes only)
  if ($s -ge 48) {
    $cols = @(
      [System.Drawing.Color]::FromArgb(255, 205, 60),
      [System.Drawing.Color]::FromArgb(240, 90, 80),
      [System.Drawing.Color]::FromArgb(80, 160, 240)
    )
    $cell = 18 * $u; $gap = 4 * $u
    for ($i = 0; $i -lt 5; $i++) {
      $c = $cols[$i % 3]
      $br = New-Object System.Drawing.SolidBrush $c
      $g.FillPath($br, (RoundRect (10 * $u + $i * ($cell + $gap)) (10 * $u) $cell $cell (4 * $u)))
      $g.FillPath($br, (RoundRect (10 * $u + $i * ($cell + $gap)) (100 * $u) $cell $cell (4 * $u)))
    }
  }

  # white die showing five
  if ($s -ge 48) { $dx = 30 * $u; $dw = 68 * $u; $dy = 32 * $u } else { $dx = 18 * $u; $dw = 92 * $u; $dy = 18 * $u }
  $die = RoundRect $dx $dy $dw $dw (14 * $u)
  $g.FillPath([System.Drawing.Brushes]::White, $die)
  if ($s -ge 32) {
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(30, 90, 50)), ([Math]::Max(1, 3 * $u))
    $g.DrawPath($pen, $die)
  }
  $pr = $dw * 0.11
  $red = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(220, 40, 50))
  $dark = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(40, 40, 40))
  foreach ($pt in @(@(0.27, 0.27), @(0.73, 0.27), @(0.27, 0.73), @(0.73, 0.73))) {
    $cx = $dx + $dw * $pt[0]; $cy = $dy + $dw * $pt[1]
    $g.FillEllipse($dark, $cx - $pr, $cy - $pr, $pr * 2, $pr * 2)
  }
  $cr = $pr * 1.25
  $g.FillEllipse($red, $dx + $dw / 2 - $cr, $dy + $dw / 2 - $cr, $cr * 2, $cr * 2)

  $g.Dispose()
  $bmp.Save((Join-Path $OutDir "icon$s.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
