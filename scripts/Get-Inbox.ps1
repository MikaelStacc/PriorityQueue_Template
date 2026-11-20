<#
Reads every card in ..\cards, checks the repo copies they claim, and writes ..\INBOX.md.
-Check validates and prints warnings without writing the inbox.
-Json prints the board as JSON for the app (app\server.js) and writes nothing.
#>
param([switch]$Check, [switch]$Json)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
# config.json holds the owner's setup: where the projects are and which optional parts are on.
$config = Get-Content (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$projects = $config.projectsRoot
$useCopies = [bool]$config.repoCopies.enabled
$today = (Get-Date).Date

$required = 'id','title','repo','branch','state','action','next_step','blocks_agent','prod','ado_prio','ado_state','pr','bounces','revisit','updated'
$states = 'agent','you','decided','review','parked','done'
$actions = 'decide','go','test','explain','draft','unblock','none'

$warnings = New-Object System.Collections.Generic.List[string]
$cards = @()

foreach ($file in Get-ChildItem (Join-Path $root 'cards') -Filter *.md | Where-Object { $_.Name -notlike '_*' }) {
    $lines = [IO.File]::ReadAllLines($file.FullName)
    if ($lines.Count -eq 0 -or $lines[0] -ne '---') { $warnings.Add("$($file.Name): no frontmatter"); continue }
    $end = [Array]::IndexOf($lines, '---', 1)
    if ($end -lt 0) { $warnings.Add("$($file.Name): frontmatter not closed"); continue }

    $fm = @{}
    foreach ($l in $lines[1..($end - 1)]) {
        if ($l -match '^([a-z_]+):\s*(.*)$') { $fm[$Matches[1]] = $Matches[2].Trim() }
    }
    $missing = $required | Where-Object { -not $fm.ContainsKey($_) }
    if ($missing) { $warnings.Add("$($file.Name): missing $($missing -join ', ')"); continue }
    if ($states -notcontains $fm.state) { $warnings.Add("$($file.Name): unknown state '$($fm.state)'") }
    if ($actions -notcontains $fm.action) { $warnings.Add("$($file.Name): unknown action '$($fm.action)'") }
    if ($fm.state -eq 'you' -and $fm.action -eq 'none') { $warnings.Add("$($file.Name): state you needs an action") }
    if ($fm.state -eq 'agent' -and $fm.next_step -eq 'none') { $warnings.Add("$($file.Name): state agent needs a next_step") }
    if ($fm.state -eq 'parked' -and $fm.revisit -eq 'none') { $warnings.Add("$($file.Name): state parked needs a revisit date") }
    if ($fm.state -eq 'review' -and $fm.pr -eq 'none') { $warnings.Add("$($file.Name): state review needs a pr") }

    # First question under "Waiting on you", and how many there are.
    $body = $lines[($end + 1)..($lines.Count - 1)]
    $start = [Array]::IndexOf($body, '## Waiting on you')
    $questions = @()
    if ($start -ge 0) {
        for ($i = $start + 1; $i -lt $body.Count -and $body[$i] -notmatch '^## '; $i++) {
            if ($body[$i] -match '^\d+\.\s+(.*)$') { $questions += $Matches[1] }
        }
    }
    if ($fm.state -eq 'you' -and $questions.Count -eq 0) { $warnings.Add("$($file.Name): state you but no numbered question") }

    $updated = [datetime]::ParseExact($fm.updated, 'yyyy-MM-dd', $null)
    $cards += [pscustomobject]@{
        Id = $fm.id; Title = $fm.title; File = $file.Name
        Repo = $fm.repo; Branch = $fm.branch; State = $fm.state; Action = $fm.action
        NextStep = $fm.next_step; BlocksAgent = ($fm.blocks_agent -eq 'yes'); Prod = ($fm.prod -eq 'yes')
        AdoPrio = [int]$fm.ado_prio; AdoState = $fm.ado_state; Pr = $fm.pr
        # Optional: only review cards have it, written by the app's In review action.
        Reviewer = $(if ($fm.reviewer) { $fm.reviewer } else { 'none' })
        Bounces = [int]$fm.bounces; Revisit = $fm.revisit
        Updated = $updated; Age = ($today - $updated).Days
        Questions = $questions
    }
}

# Repo copies: what each one has checked out, and which open card claims it.
# Free means a new card can take it: no open card, clean, and on the base branch new work starts from (baseBranch in ado.json).
# Off in config.json (repoCopies.enabled), there are no copies and cards keep repo: none.
$base = (Get-Content (Join-Path $root 'ado.json') -Raw -Encoding UTF8 | ConvertFrom-Json).baseBranch
if ($useCopies -and -not $base) { $warnings.Add('ado.json has no baseBranch, so no repo copy counts as free') }
$copies = @()
$copyDirs = @()
# Junctions are skipped: a junction that points at another copy would count it twice.
if ($useCopies) { $copyDirs = @(Get-ChildItem $projects -Directory | Where-Object { $_.Name -like $config.repoCopies.pattern -and -not $_.LinkType }) }
foreach ($dir in $copyDirs) {
    $git = Test-Path (Join-Path $dir.FullName '.git')
    $branch = ''; $dirty = 0
    if ($git) {
        $branch = (& git -C $dir.FullName branch --show-current) -join ''
        $dirty = @(& git -C $dir.FullName status --porcelain).Count
    }
    $claims = @($cards | Where-Object { $_.Repo -eq $dir.Name -and $_.State -ne 'done' })
    if ($claims.Count -gt 1) { $warnings.Add("$($dir.Name) is claimed by cards $(($claims.Id) -join ', '). One copy holds one card.") }
    $free = $git -and $claims.Count -eq 0 -and $dirty -eq 0 -and $base -and $branch -eq $base
    $copies += [pscustomobject]@{ Name = $dir.Name; Git = $git; Branch = $branch; Dirty = $dirty; Card = ($claims.Id -join ', '); Free = [bool]$free; Base = $base }
}

foreach ($c in $cards | Where-Object { $_.State -ne 'done' -and $_.Repo -ne 'none' }) {
    $copy = $copies | Where-Object { $_.Name -eq $c.Repo }
    if (-not $copy) { $warnings.Add("$($c.File): repo $($c.Repo) not found"); continue }
    if ($copy.Branch -ne $c.Branch) { $warnings.Add("$($c.File): $($c.Repo) is on '$($copy.Branch)', card says '$($c.Branch)'") }
}

# order.json is the order the owner dragged the cards into in the app, and it overrules the flags. Cards it doesn't list
# come after the listed ones, in the automatic order.
$orderFile = Join-Path $root 'order.json'
# Assigned first, then cast: in PowerShell 5.1 ConvertFrom-Json writes a JSON array as one object, so @(...) would nest it.
$order = @()
if (Test-Path $orderFile) { $order = Get-Content $orderFile -Raw -Encoding UTF8 | ConvertFrom-Json }
$order = [string[]]@($order)
$you = @($cards | Where-Object State -eq 'you' |
    Sort-Object @{ e = { $i = [Array]::IndexOf($order, $_.Id); if ($i -lt 0) { [int]::MaxValue } else { $i } } },
                @{ e = { $_.BlocksAgent }; Descending = $true }, @{ e = { $_.Prod }; Descending = $true },
                @{ e = { $_.AdoPrio }; Descending = $true }, @{ e = { $_.Updated }; Descending = $false })
$decided = @($cards | Where-Object State -eq 'decided' | Sort-Object Updated)
$agent = @($cards | Where-Object State -eq 'agent' | Sort-Object Updated)
# Review: the work is done and the PR waits on reviewers. Nothing to do for the owner or the agent until it comes back.
$review = @($cards | Where-Object State -eq 'review' | Sort-Object Updated)
$parked = @($cards | Where-Object State -eq 'parked' | Sort-Object Revisit)

if ($Json) {
    $out = { param($list) @($list | Select-Object Id, Title, File, Repo, Branch, State, Action, NextStep, BlocksAgent, Prod,
        AdoPrio, AdoState, Pr, Reviewer, Bounces, Revisit, Age, @{ n = 'Updated'; e = { $_.Updated.ToString('yyyy-MM-dd') } }, Questions) }
    $board = [ordered]@{
        # @() again: a script block's output is unrolled, so an empty list would be null and one card a bare object.
        you = @(& $out $you); decided = @(& $out $decided); agent = @(& $out $agent); review = @(& $out $review); parked = @(& $out $parked)
        copies = @($copies); warnings = @($warnings)
    }
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    [Console]::Out.Write(($board | ConvertTo-Json -Depth 5 -Compress))
    return
}
foreach ($w in $warnings) { Write-Warning $w }
"$($you.Count) waiting on you, $($decided.Count) decided, $($agent.Count) with the agent, $($review.Count) in review, $($parked.Count) parked, $($warnings.Count) warnings."
if ($Check) { return }

$prioName = @{ 1 = 'Low'; 2 = 'Medium'; 3 = 'High'; 4 = 'Urgent' }
$sb = New-Object System.Text.StringBuilder
$null = $sb.AppendLine('# Inbox')
$null = $sb.AppendLine()
$null = $sb.AppendLine("Generated $(Get-Date -Format 'yyyy-MM-dd HH:mm') by scripts/Get-Inbox.ps1. Don't edit; edit the cards.")
$null = $sb.AppendLine()
$null = $sb.AppendLine("## Waiting on you ($($you.Count))")
$null = $sb.AppendLine()
if ($you.Count -eq 0) { $null = $sb.AppendLine('Nothing.') }
$rank = 0
foreach ($c in $you) {
    $rank++
    $flags = @()
    if ($c.BlocksAgent) { $flags += 'unblocks agent' }
    $flags += $prioName[$c.AdoPrio]
    if ($c.Bounces -ge 2) { $flags += "BOUNCED $($c.Bounces)x, rephrase or park" }
    $more = if ($c.Questions.Count -gt 1) { " (+$($c.Questions.Count - 1) more)" } else { '' }
    $null = $sb.AppendLine("$rank. [$($c.Id)](cards/$($c.File)) $($c.Title). **$($c.Action)**, $($c.Age) d. $($flags -join ', ')")
    $null = $sb.AppendLine("   $($c.Questions[0])$more")
}
$null = $sb.AppendLine()
if ($decided.Count -gt 0) {
    $null = $sb.AppendLine("## Decided, waiting for /q cycle ($($decided.Count))")
    $null = $sb.AppendLine()
    foreach ($c in $decided) { $null = $sb.AppendLine("- [$($c.Id)](cards/$($c.File)) $($c.Title). Decided $($c.Updated.ToString('yyyy-MM-dd'))") }
    $null = $sb.AppendLine()
}
$null = $sb.AppendLine("## With the agent ($($agent.Count))")
$null = $sb.AppendLine()
if ($agent.Count -eq 0) { $null = $sb.AppendLine('Nothing.') }
foreach ($c in $agent) { $null = $sb.AppendLine("- [$($c.Id)](cards/$($c.File)) $($c.Title). Next: $($c.NextStep)") }
$null = $sb.AppendLine()
$null = $sb.AppendLine("## In review ($($review.Count))")
$null = $sb.AppendLine()
if ($review.Count -eq 0) { $null = $sb.AppendLine('Nothing.') }
foreach ($c in $review) { $null = $sb.AppendLine("- [$($c.Id)](cards/$($c.File)) $($c.Title). PR $($c.Pr)$(if ($c.Reviewer -ne 'none') { ", reviewed by $($c.Reviewer)" }), since $($c.Updated.ToString('yyyy-MM-dd'))") }
$null = $sb.AppendLine()
$null = $sb.AppendLine("## Parked ($($parked.Count))")
$null = $sb.AppendLine()
if ($parked.Count -eq 0) { $null = $sb.AppendLine('Nothing.') }
foreach ($c in $parked) {
    $due = if ($c.Revisit -ne 'none' -and [datetime]::ParseExact($c.Revisit, 'yyyy-MM-dd', $null) -le $today) { ' **due**' } else { '' }
    $null = $sb.AppendLine("- [$($c.Id)](cards/$($c.File)) $($c.Title). Revisit $($c.Revisit)$due")
}
$null = $sb.AppendLine()
if ($useCopies) {
    $null = $sb.AppendLine('## Repo copies')
    $null = $sb.AppendLine()
}
foreach ($r in $copies) {
    if (-not $r.Git) { $null = $sb.AppendLine("- $($r.Name): not a git repo"); continue }
    $owner = if ($r.Card) { "card $($r.Card)" } elseif ($r.Free) { 'free' } elseif ($r.Dirty) { 'idle, not clean' } else { "idle, not on $base" }
    $null = $sb.AppendLine("- $($r.Name): ``$($r.Branch)``, $($r.Dirty) dirty, $owner")
}
if ($warnings.Count -gt 0) {
    $null = $sb.AppendLine()
    $null = $sb.AppendLine("## Warnings ($($warnings.Count))")
    $null = $sb.AppendLine()
    foreach ($w in $warnings) { $null = $sb.AppendLine("- $w") }
}

[IO.File]::WriteAllText((Join-Path $root 'INBOX.md'), $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
"Wrote $(Join-Path $root 'INBOX.md')"
