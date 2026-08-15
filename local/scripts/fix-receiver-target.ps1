# The media receiver was writing to F:\GoliathOmni\ComfyUI\input\Inbox, but the
# live ComfyUI is at F:\Mark Pires\ComfyUI. Uploads were landing in a folder
# ComfyUI never reads. This repoints the receiver and moves any stranded files.

$cfgPath = "F:\GoliathOmni\config.json"
$oldInbox = "F:\GoliathOmni\ComfyUI\input\Inbox"
$newInbox = "F:\Mark Pires\ComfyUI\input\Inbox"

New-Item -ItemType Directory -Force -Path $newInbox | Out-Null

if (Test-Path $oldInbox) {
  $stranded = Get-ChildItem $oldInbox -File -ErrorAction SilentlyContinue
  if ($stranded) {
    Write-Host "Moving $($stranded.Count) stranded upload(s) to the live inbox..." -ForegroundColor Cyan
    robocopy $oldInbox $newInbox /MOV /R:2 /W:2 | Out-Null
  }
}

$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
$cfg.TARGET_DIR = $newInbox
$cfg | ConvertTo-Json -Depth 5 | Set-Content $cfgPath -Encoding UTF8

Write-Host "TARGET_DIR is now $newInbox" -ForegroundColor Green
Write-Host "Restart run_media_receiver.bat for it to take effect." -ForegroundColor Yellow
