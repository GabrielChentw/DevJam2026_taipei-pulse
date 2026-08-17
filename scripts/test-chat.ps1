# Manual test helper for POST /api/chat.
#
# Usage:
#   Single message:
#     powershell -ExecutionPolicy Bypass -File scripts\test-chat.ps1 -Message "some text"
#
#   Interactive multi-turn conversation (same session, keeps context):
#     powershell -ExecutionPolicy Bypass -File scripts\test-chat.ps1 -Interactive
#
# Prerequisite: backend must be running first.
#   cd api
#   .\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000
#
# NOTE: ASCII only. Windows PowerShell 5.1 reads .ps1 as ANSI (the active
# codepage, not UTF-8), so non-ASCII characters -- including Chinese text in
# comments or string literals -- corrupt multi-byte sequences and can break
# brace matching, causing MissingEndCurlyBrace errors that point at the wrong
# line. Keep this file pure ASCII; pass Chinese test messages via -Message
# from the command line instead of hardcoding them here.

param(
    [string]$Message = "",
    [string]$SessionId = "manual-test",
    [string]$BaseUrl = "http://127.0.0.1:8000",
    [switch]$Interactive
)

function Send-ChatMessage {
    param([string]$Text, [string]$Session)

    $body = @{ session_id = $Session; message = $Text } | ConvertTo-Json -Compress

    try {
        $response = Invoke-RestMethod -Uri "$BaseUrl/api/chat" -Method Post `
            -ContentType "application/json; charset=utf-8" `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
        return $response
    }
    catch {
        $status = $_.Exception.Response.StatusCode.value__
        Write-Host "HTTP $status" -ForegroundColor Red
        Write-Host $_.ErrorDetails.Message -ForegroundColor Red
        return $null
    }
}

function Show-ChatResponse {
    param($Response)

    if ($null -eq $Response) { return }

    Write-Host ""
    Write-Host "--- agent reply ---" -ForegroundColor Cyan
    Write-Host $Response.reply
    Write-Host ""

    if ($Response.plan) {
        $feasibleCount = $Response.plan.feasible.Count
        $excludedCount = $Response.plan.excluded.Count
        Write-Host "[plan] feasible=$feasibleCount excluded=$excludedCount" -ForegroundColor DarkGray
    }
    else {
        Write-Host "[plan] null (no planning tool was called this turn)" -ForegroundColor DarkGray
    }

    if ($Response.compare) {
        Write-Host "[compare] divergence: $($Response.compare.divergence)" -ForegroundColor DarkGray
    }

    if ($Response.camera_commands.Count -gt 0) {
        foreach ($cmd in $Response.camera_commands) {
            Write-Host "[camera] $($cmd.action) -> route=$($cmd.route_candidate_id)" -ForegroundColor DarkGray
        }
    }
    else {
        Write-Host "[camera] no commands" -ForegroundColor DarkGray
    }
}

if ($Interactive) {
    Write-Host "Interactive mode. session_id=$SessionId. Type exit to quit." -ForegroundColor Yellow
    while ($true) {
        Write-Host ""
        $userText = Read-Host "you"
        if ($userText -eq "exit" -or $userText -eq "") { break }
        $chatResponse = Send-ChatMessage -Text $userText -Session $SessionId
        Show-ChatResponse -Response $chatResponse
    }
}
elseif ($Message -ne "") {
    Write-Host "you: $Message" -ForegroundColor Yellow
    $chatResponse = Send-ChatMessage -Text $Message -Session $SessionId
    Show-ChatResponse -Response $chatResponse
}
else {
    Write-Host "Usage:"
    Write-Host '  Single message: powershell -ExecutionPolicy Bypass -File scripts\test-chat.ps1 -Message "your text"'
    Write-Host '  Interactive:     powershell -ExecutionPolicy Bypass -File scripts\test-chat.ps1 -Interactive'
}
