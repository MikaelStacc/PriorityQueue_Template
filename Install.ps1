<#
Sets up this folder as your own priority queue board. Run it once, from your own terminal:

  powershell -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -Owner "Your Name"

-Owner         your name, as it goes into Decisions entries on the cards
-ProjectsRoot  the folder your repo checkouts live in (default C:\Projects)
-Startup       also add a shortcut to the Startup folder, so the server starts hidden at logon

It writes config.json, makes the folder a git repo on main if it isn't one, builds INBOX.md and commits the start.
Turn on Harvest, repo copies and object IDs by editing config.json afterwards; README.md says what each one does.
Run it again any time: it only changes what you pass.
#>
param(
    [string]$Owner,
    [string]$ProjectsRoot,
    [switch]$Startup
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

foreach ($tool in 'node', 'git', 'claude') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not on PATH. Install it first." }
}

$configFile = Join-Path $root 'config.json'
$config = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Owner) { $config.owner = $Owner }
if ($ProjectsRoot) { $config.projectsRoot = $ProjectsRoot }
if ($config.owner -eq 'Your Name') { Write-Warning 'config.json still says "Your Name". Run again with -Owner "<your name>".' }
if (-not (Test-Path $config.projectsRoot)) { Write-Warning "projectsRoot $($config.projectsRoot) doesn't exist." }
# Written only when something was passed: ConvertTo-Json in PowerShell 5.1 re-indents the whole file.
if ($Owner -or $ProjectsRoot) {
    [IO.File]::WriteAllText($configFile, ($config | ConvertTo-Json -Depth 5) + "`n", (New-Object System.Text.UTF8Encoding($false)))
}
"config.json: owner $($config.owner), projects in $($config.projectsRoot)"

if (-not (Test-Path (Join-Path $root '.git'))) {
    git -C $root init -q -b main
    'Made the board a git repo on main. It commits locally; the app pushes once you add a remote named origin.'
}
# A clone of the template has origin pointing at the template, and the app pushes to origin after every card change.
# Renamed to "template", so your cards stay local until you add your own origin, and `git pull template main` still
# brings template updates.
$origin = (git -C $root remote) -contains 'origin'
if ($origin -and ((git -C $root remote get-url origin) -match 'PriorityQueue_Template')) {
    git -C $root remote rename origin template
    'Renamed the remote origin to template. Add your own origin to have the board pushed.'
}

powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\Get-Inbox.ps1')

# -q keeps rev-parse quiet on a repo with no commits; stderr from git would stop the script in PowerShell 5.1.
if (-not (git -C $root rev-parse -q --verify HEAD)) {
    git -C $root add -- .
    git -C $root commit -q -m 'board: start from the template'
    'Committed the start.'
} elseif (git -C $root status --porcelain -- config.json INBOX.md) {
    # A clone already has the template's commits; only your setup is new.
    git -C $root add -- config.json INBOX.md
    git -C $root commit -q -m "board: set up for $($config.owner)" -- config.json INBOX.md
    'Committed your setup.'
}

if ($Startup) {
    $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Priority Queue server.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $s = $shell.CreateShortcut($lnk)
    $s.TargetPath = Join-Path $root 'app\restart.cmd'
    $s.WorkingDirectory = Join-Path $root 'app'
    $s.WindowStyle = 7
    $s.Save()
    "Startup shortcut: $lnk"
}

''
'Next:'
'  1. Start the app: app\start.cmd (opens http://localhost:4747).'
'  2. In Claude Code, connect the Azure DevOps MCP server (azure-devops) if you have not, and Harvest if you turn it on.'
'  3. Press Pull once to fetch the iteration list, pick the current iteration, and Pull again.'
