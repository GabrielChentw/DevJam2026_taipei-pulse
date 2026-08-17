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
    [switch]$Interactive,
    [string]$LogFile = "chat-log.txt"
)

# Mojibake mitigation: the JSON response from the backend is correct UTF-8
# (verified independently, e.g. by reading it back with Python). The garbled
# text some terminals show is a *display* problem: Windows PowerShell 5.1's
# console defaults to the system's active codepage for Write-Host output, and
# that codepage is not always UTF-8. Setting Console.OutputEncoding here fixes
# it in many terminals (Windows Terminal, VS Code's integrated terminal), but
# is NOT reliable across every host -- some hosts (legacy conhost.exe with
# certain codepages, some CI/automation harnesses) ignore this setting.
#
# Because display-layer fixes cannot be guaranteed, this script ALSO writes
# every response to a UTF-8 file (see -LogFile) as a fallback that is immune
# to console rendering entirely. If text on screen still looks garbled after
# this fix, open the log file in a text editor instead of trusting the
# terminal.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Utf8Log {
    param([string]$Path, [string]$Text)
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::AppendAllText($Path, $Text + "`r`n`r`n", $utf8NoBom)
}

function Send-ChatMessage {
    param([string]$Text, [string]$Session)

    $body = @{ session_id = $Session; message = $Text } | ConvertTo-Json -Compress

    # Deliberately NOT using Invoke-RestMethod here. Windows PowerShell 5.1's
    # Invoke-RestMethod has a known bug: when the response Content-Type lacks an
    # explicit charset (FastAPI's default is "application/json" with no charset),
    # it decodes the body as ISO-8859-1 instead of UTF-8. JSON is UTF-8 by spec, so
    # any non-ASCII text gets corrupted at this exact step -- before it ever
    # reaches Write-Host or a log file, which is why encoding fixes downstream of
    # this call cannot help. Confirmed by writing the "fixed" output straight to a
    # UTF-8 file and finding the file itself already corrupted.
    #
    # The fix is to fetch raw bytes via Invoke-WebRequest -UseBasicParsing and
    # decode them as UTF-8 ourselves, bypassing IRM's charset guessing entirely.
    try {
        $webResponse = Invoke-WebRequest -Uri "$BaseUrl/api/chat" -Method Post `
            -ContentType "application/json; charset=utf-8" `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) `
            -UseBasicParsing

        $rawBytes = $webResponse.RawContentStream.ToArray()
        $jsonText = [System.Text.Encoding]::UTF8.GetString($rawBytes)
        return $jsonText | ConvertFrom-Json
    }
    catch {
        $status = $_.Exception.Response.StatusCode.value__
        Write-Host "HTTP $status" -ForegroundColor Red

        # Error bodies need the same UTF-8 rescue -- $_.ErrorDetails.Message goes
        # through the same broken IRM decoding path.
        try {
            $errorStream = $_.Exception.Response.GetResponseStream()
            $reader = New-Object System.IO.StreamReader($errorStream, [System.Text.Encoding]::UTF8)
            Write-Host $reader.ReadToEnd() -ForegroundColor Red
        }
        catch {
            Write-Host $_.ErrorDetails.Message -ForegroundColor Red
        }
        return $null
    }
}

function Show-ChatResponse {
    param($Response, [string]$LogFile)

    if ($null -eq $Response) { return }

    Write-Host ""
    Write-Host "--- agent reply ---" -ForegroundColor Cyan
    Write-Host $Response.reply
    Write-Host ""
    if ($LogFile) {
        Write-Utf8Log -Path $LogFile -Text $Response.reply
        Write-Host "(also written to $LogFile as UTF-8 -- open that file if the text above looks garbled)" -ForegroundColor DarkGray
    }

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
    Write-Host "Replies are also logged to $LogFile as UTF-8." -ForegroundColor DarkGray
    while ($true) {
        Write-Host ""
        $userText = Read-Host "you"
        if ($userText -eq "exit" -or $userText -eq "") { break }
        $chatResponse = Send-ChatMessage -Text $userText -Session $SessionId
        Show-ChatResponse -Response $chatResponse -LogFile $LogFile
    }
}
elseif ($Message -ne "") {
    Write-Host "you: $Message" -ForegroundColor Yellow
    $chatResponse = Send-ChatMessage -Text $Message -Session $SessionId
    Show-ChatResponse -Response $chatResponse -LogFile $LogFile
}
else {
    Write-Host "Usage:"
    Write-Host '  Single message: powershell -ExecutionPolicy Bypass -File scripts\test-chat.ps1 -Message "your text"'
    Write-Host '  Interactive:     powershell -ExecutionPolicy Bypass -File scripts\test-chat.ps1 -Interactive'
    Write-Host '  Custom log path: add -LogFile "path\to\file.txt" (default: chat-log.txt)'
}
