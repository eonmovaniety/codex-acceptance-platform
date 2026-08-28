[CmdletBinding()]
param(
  [ValidateSet('install', 'verify', 'backup', 'restore', 'uninstall')]
  [string]$Action = 'install',
  [string]$BackupId
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ForgejoVersion = '16.0.3'
$ForgejoTag = "codeberg.org/forgejo/forgejo:$ForgejoVersion-rootless"
$NasHost = 'nas-n100'
$NasAddress = '192.168.31.9'
$NasRoot = '/volume3/docker/forgejo'
$ForgejoUrl = 'http://192.168.31.9:3000'
$ForgejoAdmin = 'Silmaril'
$CapRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$AtmosphereRoot = 'C:\Users\18373\Documents\CodexProject\AtmosphereEngine\AtmosphereEngine'
$CapHome = Join-Path $env:USERPROFILE '.codex-acceptance'
$SshExe = 'C:\Windows\System32\OpenSSH\ssh.exe'
$ScpExe = 'C:\Windows\System32\OpenSSH\scp.exe'
$SshKey = Join-Path $env:USERPROFILE '.ssh\id_ed25519'
$KnownHosts = Join-Path $env:USERPROFILE '.ssh\known_hosts'
$NodeExe = (Get-Command node.exe).Source
$CliPath = Join-Path $CapRoot 'dist\src\cli.js'

function Write-Step([string]$Message) {
  Write-Host "[Forgejo] $Message" -ForegroundColor Cyan
}

function Invoke-Nas([string]$Command, [switch]$AllowFailure) {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = & $SshExe -o BatchMode=yes -o ConnectTimeout=15 -o IdentityAgent=none -o IdentitiesOnly=yes -i $SshKey $NasHost $Command 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($code -ne 0 -and -not $AllowFailure) {
    throw "NAS command failed ($code): $($output -join [Environment]::NewLine)"
  }
  return @($output)
}

function Copy-ToNas([string]$LocalPath, [string]$RemotePath) {
  & $ScpExe -O -o BatchMode=yes -o ConnectTimeout=15 -o IdentityAgent=none -o IdentitiesOnly=yes -i $SshKey $LocalPath "${NasHost}:$RemotePath"
  if ($LASTEXITCODE -ne 0) { throw "Could not copy $LocalPath to NAS" }
}

function Invoke-Cap([string[]]$Arguments) {
  & $NodeExe $CliPath @Arguments --home $CapHome --json
  if ($LASTEXITCODE -ne 0) { throw "CAP command failed: $($Arguments -join ' ')" }
}

function Get-PlainText([Security.SecureString]$Secure) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Save-ForgejoToken([string]$Token, [string]$Path) {
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  [IO.File]::WriteAllText($Path, "$Token`n", [Text.UTF8Encoding]::new($false))
  $acl = & icacls.exe $Path /inheritance:r /grant:r "${env:USERNAME}:(R,W)" 2>&1
  if ($LASTEXITCODE -ne 0) {
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    throw "Could not restrict Forgejo token ACL: $($acl -join ' ')"
  }
}

function Install-CapWorker {
  $installation = Join-Path $CapRoot '.git\cap-automation\installation.json'
  $hook = Join-Path $CapRoot '.git\hooks\post-commit'
  if ((Test-Path -LiteralPath $installation) -and
      (Test-Path -LiteralPath $hook) -and
      ((Get-Content -Raw -LiteralPath $hook) -like '*CAP_AUTOMATION_HOOK_BEGIN*')) {
    Write-Step 'CAP login Worker is already registered'
    return
  }
  $command = "& '$NodeExe' '$CliPath' automation install --project codex-acceptance-platform --task cap-self-test --home '$CapHome'"
  $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    $command
  ) -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Elevated CAP Worker registration failed with exit code $($process.ExitCode)"
  }
}

function Wait-Forgejo {
  for ($attempt = 1; $attempt -le 60; $attempt++) {
    try {
      $health = Invoke-RestMethod -Uri "$ForgejoUrl/api/healthz" -TimeoutSec 5
      if ($health.status -eq 'pass' -or $health.status -eq 'ok') { return }
    } catch {}
    Start-Sleep -Seconds 2
  }
  throw 'Forgejo did not become healthy within 120 seconds'
}

function Invoke-ForgejoApi(
  [string]$Token,
  [string]$Method,
  [string]$Path,
  $Body
) {
  $headers = @{ Authorization = "token $Token"; Accept = 'application/json' }
  $parameters = @{
    Uri = "$ForgejoUrl/api/v1$Path"
    Method = $Method
    Headers = $headers
    TimeoutSec = 30
  }
  if ($null -ne $Body) {
    $parameters.ContentType = 'application/json'
    $parameters.Body = ($Body | ConvertTo-Json -Depth 20 -Compress)
  }
  return Invoke-RestMethod @parameters
}

function Ensure-Repository([string]$Token, [string]$Name, [bool]$Private) {
  try {
    return Invoke-ForgejoApi $Token GET "/repos/$ForgejoAdmin/$Name" $null
  } catch {
    if ($_.Exception.Response.StatusCode.value__ -ne 404) { throw }
  }
  return Invoke-ForgejoApi $Token POST '/user/repos' @{
    name = $Name
    private = $Private
    auto_init = $false
    default_branch = 'master'
  }
}

function Ensure-SshKey([string]$Token) {
  $publicKeyPath = "$SshKey.pub"
  if (-not (Test-Path -LiteralPath $publicKeyPath)) { throw "SSH public key missing: $publicKeyPath" }
  $publicKey = (Get-Content -Raw -LiteralPath $publicKeyPath).Trim()
  $keys = @(Invoke-ForgejoApi $Token GET '/user/keys?limit=50' $null)
  if ($keys | Where-Object { $_.key -eq $publicKey }) { return }
  Invoke-ForgejoApi $Token POST '/user/keys' @{
    title = "CAP-$env:COMPUTERNAME"
    key = $publicKey
    read_only = $false
  } | Out-Null
}

function Ensure-BranchProtection(
  [string]$Token,
  [string]$Repository,
  [string]$Context
) {
  $body = @{
    branch_name = 'master'
    enable_push = $false
    enable_force_push = $false
    enable_status_check = $true
    status_check_contexts = @($Context)
    required_approvals = 0
    dismiss_stale_approvals = $true
    block_on_rejected_reviews = $true
    block_on_official_review_requests = $true
    apply_to_admins = $true
  }
  try {
    Invoke-ForgejoApi $Token POST "/repos/$ForgejoAdmin/$Repository/branch_protections" $body | Out-Null
  } catch {
    if ($_.Exception.Response.StatusCode.value__ -ne 422) { throw }
    Invoke-ForgejoApi $Token PATCH "/repos/$ForgejoAdmin/$Repository/branch_protections/master" $body | Out-Null
  }
}

function Ensure-ForgejoHostKey {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $keyscan = & ssh-keyscan.exe -p 2222 $NasAddress 2>$null
    $keyscanExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($keyscanExitCode -ne 0 -or -not $keyscan) { throw 'Could not read Forgejo SSH host key' }
  $existing = if (Test-Path -LiteralPath $KnownHosts) { Get-Content -LiteralPath $KnownHosts } else { @() }
  if (-not ($existing | Where-Object { $_ -like "[$NasAddress]:2222 *" })) {
    $backup = "$KnownHosts.cap-forgejo-$(Get-Date -Format yyyyMMddHHmmss).bak"
    if (Test-Path -LiteralPath $KnownHosts) { Copy-Item -LiteralPath $KnownHosts -Destination $backup }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $KnownHosts) | Out-Null
    Add-Content -LiteralPath $KnownHosts -Value $keyscan -Encoding UTF8
  }
}

function Migrate-Repository(
  [string]$Name,
  [string]$GitHubUrl
) {
  $temporary = Join-Path ([IO.Path]::GetTempPath()) "forgejo-mirror-$Name-$([guid]::NewGuid().ToString('N'))"
  try {
    & git clone --mirror $GitHubUrl $temporary
    if ($LASTEXITCODE -ne 0) { throw "Could not mirror-clone $GitHubUrl" }
    $destination = "ssh://git@${NasAddress}:2222/$ForgejoAdmin/$Name.git"
    $env:GIT_SSH_COMMAND = "`"$SshExe`" -o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -i `"$SshKey`""
    & git --git-dir $temporary push --mirror $destination
    if ($LASTEXITCODE -ne 0) { throw "Could not push mirror for $Name" }
    $sourceRefs = @(& git --git-dir $temporary for-each-ref '--format=%(refname)|%(objectname)' refs/heads refs/tags)
    $remoteRefs = @(& git ls-remote --heads --tags $destination | ForEach-Object {
      $parts = $_ -split "`t"; if ($parts[1] -notlike '*^{}') { "$($parts[1])|$($parts[0])" }
    })
    $missing = Compare-Object ($sourceRefs | Sort-Object) ($remoteRefs | Sort-Object)
    if ($missing) { throw "Ref verification failed for ${Name}: $($missing | Out-String)" }
  } finally {
    Remove-Item Env:GIT_SSH_COMMAND -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
  }
}

function Set-AuthoritativeRemote([string]$RepositoryRoot, [string]$Name) {
  $forgejo = "ssh://git@${NasAddress}:2222/$ForgejoAdmin/$Name.git"
  $remotes = @(& git -C $RepositoryRoot remote)
  if ($remotes -contains 'origin') {
    $origin = (& git -C $RepositoryRoot remote get-url origin).Trim()
    if ($origin -like 'https://github.com/*' -and -not ($remotes -contains 'github')) {
      & git -C $RepositoryRoot remote rename origin github
      if ($LASTEXITCODE -ne 0) { throw "Could not preserve GitHub remote for $Name" }
      $remotes = @(& git -C $RepositoryRoot remote)
    }
  }
  if ($remotes -contains 'origin') { & git -C $RepositoryRoot remote set-url origin $forgejo }
  else { & git -C $RepositoryRoot remote add origin $forgejo }
  if ($LASTEXITCODE -ne 0) { throw "Could not configure Forgejo origin for $Name" }
}

function Install-BackupSchedule {
  $command = @'
set -eu
ROOT=/volume3/docker/forgejo
STAMP=$(date +%Y%m%d-%H%M%S)
if ! grep -q 'CAP_FORGEJO_BACKUP' /etc/crontab; then
  cp /etc/crontab "$ROOT/backups/crontab.$STAMP.bak"
  printf '15 3 * * * root %s/backup.sh # CAP_FORGEJO_BACKUP\n' "$ROOT" >> /etc/crontab
  synosystemctl restart crond >/dev/null 2>&1 || true
fi
'@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($command))
  Invoke-Nas "echo $encoded | base64 -d | sudo -n sh" | Out-Null
}

function Install-Forgejo {
  Write-Step 'Running NAS preflight and allowlisted dangling-image cleanup'
  $preflight = @'
set -eu
DOCKER=/usr/local/bin/docker
test -x "$DOCKER"
test "$(sudo -n "$DOCKER" info --format '{{.DockerRootDir}}')" = '/volume1/@docker'
test "$(stat -f -c %T /volume3)" = 'btrfs'
for port in 3000 2222; do
  if /usr/bin/netstat -lnt | grep -Eq ":$port[[:space:]]"; then
    if ! sudo -n "$DOCKER" ps --format '{{.Names}}' | grep -qx forgejo; then
      echo "port $port is already in use" >&2; exit 20
    fi
  fi
done
target_kb=1572864
available_kb=$(df -Pk /volume1 | awk 'NR==2 {print $4}')
if [ "$available_kb" -lt "$target_kb" ]; then
  referenced=$(sudo -n "$DOCKER" ps -aq | while read id; do sudo -n "$DOCKER" inspect -f '{{.Image}}' "$id"; done | sort -u)
  sudo -n "$DOCKER" image ls -f dangling=true --no-trunc --format '{{.ID}}' | while read image; do
    echo "$referenced" | grep -qx "$image" && continue
    sudo -n "$DOCKER" image rm "$image" >/dev/null
    available_kb=$(df -Pk /volume1 | awk 'NR==2 {print $4}')
    [ "$available_kb" -ge "$target_kb" ] && break
  done
fi
available_kb=$(df -Pk /volume1 | awk 'NR==2 {print $4}')
[ "$available_kb" -ge "$target_kb" ] || { echo "Docker root still has only ${available_kb}KB free" >&2; exit 21; }
printf 'docker_free_kb=%s volume3_free_kb=%s\n' "$available_kb" "$(df -Pk /volume3 | awk 'NR==2 {print $4}')"
'@
  Invoke-Nas $preflight | ForEach-Object { Write-Host $_ }

  Write-Step "Pulling Forgejo $ForgejoVersion and resolving immutable digest"
  Invoke-Nas "sudo -n /usr/local/bin/docker pull $ForgejoTag" | Out-Null
  $digestLines = @(Invoke-Nas "sudo -n /usr/local/bin/docker image inspect --format '{{index .RepoDigests 0}}' $ForgejoTag")
  $digest = ([string]$digestLines[0]).Trim()
  if ($digest -notmatch '^codeberg\.org/forgejo/forgejo@sha256:[0-9a-f]{64}$') { throw "Invalid Forgejo digest: $digest" }

  $temp = Join-Path ([IO.Path]::GetTempPath()) "forgejo-deploy-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $temp | Out-Null
  try {
    $compose = (Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'compose.yaml.template')).Replace('__FORGEJO_IMAGE__', $digest)
    [IO.File]::WriteAllText((Join-Path $temp 'compose.yaml'), $compose, [Text.UTF8Encoding]::new($false))
    $manifest = @{
      version = 1; forgejo_version = $ForgejoVersion; image = $digest
      installed_at = [DateTime]::UtcNow.ToString('o'); data_path = "$NasRoot/data"
    } | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $temp 'deployment-manifest.json'), $manifest, [Text.UTF8Encoding]::new($false))
    Copy-ToNas (Join-Path $temp 'compose.yaml') '/tmp/cap-forgejo-compose.yaml'
    Copy-ToNas (Join-Path $temp 'deployment-manifest.json') '/tmp/cap-forgejo-manifest.json'
    Copy-ToNas (Join-Path $PSScriptRoot 'backup.sh') '/tmp/cap-forgejo-backup.sh'
    Copy-ToNas (Join-Path $PSScriptRoot 'restore.sh') '/tmp/cap-forgejo-restore.sh'
  } finally {
    Remove-Item -LiteralPath $temp -Recurse -Force
  }

  $installRemote = @'
set -eu
ROOT=/volume3/docker/forgejo
STAMP=$(date +%Y%m%d-%H%M%S)
sudo -n mkdir -p "$ROOT/data" "$ROOT/backups"
if [ -f "$ROOT/compose.yaml" ]; then sudo -n cp "$ROOT/compose.yaml" "$ROOT/backups/compose.$STAMP.bak"; fi
sudo -n install -m 0644 /tmp/cap-forgejo-compose.yaml "$ROOT/compose.yaml"
sudo -n install -m 0644 /tmp/cap-forgejo-manifest.json "$ROOT/deployment-manifest.json"
sudo -n install -m 0755 /tmp/cap-forgejo-backup.sh "$ROOT/backup.sh"
sudo -n install -m 0755 /tmp/cap-forgejo-restore.sh "$ROOT/restore.sh"
sudo -n chown -R 1000:1000 "$ROOT/data"
cd "$ROOT"
sudo -n /usr/local/bin/docker compose config >/dev/null
sudo -n /usr/local/bin/docker compose up -d forgejo
rm -f /tmp/cap-forgejo-compose.yaml /tmp/cap-forgejo-manifest.json /tmp/cap-forgejo-backup.sh /tmp/cap-forgejo-restore.sh
'@
  Invoke-Nas $installRemote | Out-Null
  Wait-Forgejo

  $adminState = [string](Invoke-Nas 'if sudo -n /usr/local/bin/docker exec forgejo forgejo --config /var/lib/gitea/custom/conf/app.ini admin user list | grep -Eq "^[[:space:]]*[0-9]+[[:space:]]+Silmaril[[:space:]]"; then printf existing; else printf missing; fi')[0]
  if ($adminState.Trim() -eq 'missing') {
    $password = Read-Host "Forgejo administrator password for $ForgejoAdmin" -AsSecureString
    $plain = Get-PlainText $password
    try {
      $createCommand = 'read -r pw; sudo -n /usr/local/bin/docker exec forgejo forgejo --config /var/lib/gitea/custom/conf/app.ini admin user create --username Silmaril --password "$pw" --email silmaril@forgejo.local --admin --must-change-password=false'
      $result = $plain | & $SshExe -o BatchMode=yes -o IdentityAgent=none -o IdentitiesOnly=yes -i $SshKey $NasHost $createCommand 2>&1
      if ($LASTEXITCODE -ne 0) { throw "Could not create Forgejo administrator: $($result -join ' ')" }
    } finally { $plain = $null }
  }

  $credentialRef = 'cap-secret://forgejo/Silmaril'
  $tokenPath = Join-Path $CapHome 'secrets\forgejo\Silmaril.token'
  if (Test-Path -LiteralPath $tokenPath) {
    $token = (Get-Content -Raw -LiteralPath $tokenPath).Trim()
  } else {
    $tokenLines = @(Invoke-Nas "sudo -n /usr/local/bin/docker exec forgejo forgejo --config /var/lib/gitea/custom/conf/app.ini admin user generate-access-token --username $ForgejoAdmin --token-name cap-poller --scopes write:repository,write:issue,write:user --raw")
    $token = ([string]$tokenLines[0]).Trim()
    if ($token.Length -ge 20) { Save-ForgejoToken $token $tokenPath }
  }
  if ($token.Length -lt 20) { throw 'Forgejo API token generation failed' }

  Write-Step 'Creating repositories, SSH key, and protected master rules'
  Ensure-Repository $token 'codex-acceptance-platform' $false | Out-Null
  Ensure-Repository $token 'atmosphere-engine' $true | Out-Null
  Ensure-SshKey $token
  Ensure-ForgejoHostKey

  Write-Step 'Migrating immutable Git refs from GitHub'
  Migrate-Repository 'codex-acceptance-platform' 'https://github.com/eonmovaniety/codex-acceptance-platform.git'
  Migrate-Repository 'atmosphere-engine' 'https://github.com/eonmovaniety/atmosphere-engine.git'

  Ensure-BranchProtection $token 'codex-acceptance-platform' 'cap/self-test'
  Ensure-BranchProtection $token 'atmosphere-engine' 'cap/atmosphere-acceptance'
  Set-AuthoritativeRemote $CapRoot 'codex-acceptance-platform'
  Set-AuthoritativeRemote $AtmosphereRoot 'atmosphere-engine'

  Write-Step 'Registering both projects and the Forgejo polling provider'
  & npm.cmd run build --prefix $CapRoot | Out-Host
  Invoke-Cap @('project', 'add', (Join-Path $CapRoot '.acceptance\project.yaml')) | Out-Host
  Invoke-Cap @('project', 'add', (Join-Path $AtmosphereRoot '.acceptance\project.yaml')) | Out-Host
  $tempToken = Join-Path ([IO.Path]::GetTempPath()) "forgejo-token-$([guid]::NewGuid().ToString('N')).txt"
  try {
    [IO.File]::WriteAllText($tempToken, "$token`n", [Text.UTF8Encoding]::new($false))
    Invoke-Cap @('automation', 'forgejo', 'install', '--project', 'codex-acceptance-platform', '--token-file', $tempToken) | Out-Host
    Invoke-Cap @('automation', 'forgejo', 'install', '--project', 'atmosphere-engine', '--token-file', $tempToken) | Out-Host
  } finally {
    if (Test-Path -LiteralPath $tempToken) { Remove-Item -LiteralPath $tempToken -Force }
    $token = $null
  }
  Install-CapWorker
  Install-BackupSchedule
  Verify-Forgejo
}

function Verify-Forgejo {
  Write-Step 'Verifying service, repositories, protection, CAP polling, and backup path'
  Wait-Forgejo
  $remote = Invoke-Nas "cd $NasRoot && sudo -n /usr/local/bin/docker compose ps --format json; test -x $NasRoot/backup.sh; test -x $NasRoot/restore.sh; df -h /volume1 /volume3"
  $remote | ForEach-Object { Write-Host $_ }
  Invoke-Cap @('automation', 'forgejo', 'verify', '--project', 'codex-acceptance-platform') | Out-Host
  Invoke-Cap @('automation', 'forgejo', 'verify', '--project', 'atmosphere-engine') | Out-Host
  Write-Host "Forgejo: $ForgejoUrl"
  Write-Host "CAP repo: $ForgejoUrl/$ForgejoAdmin/codex-acceptance-platform"
  Write-Host "AtmosphereEngine: $ForgejoUrl/$ForgejoAdmin/atmosphere-engine"
}

function Backup-Forgejo {
  Write-Step 'Creating a consistent Forgejo backup'
  Invoke-Nas "sudo -n $NasRoot/backup.sh" | ForEach-Object { Write-Host $_ }
  Wait-Forgejo
}

function Restore-Forgejo {
  if (-not $BackupId) { throw '-BackupId is required for restore' }
  $path = if ($BackupId.StartsWith('/')) { $BackupId } else { "$NasRoot/backups/$BackupId" }
  Write-Step "Restoring $path"
  Invoke-Nas "sudo -n $NasRoot/restore.sh '$path'" | ForEach-Object { Write-Host $_ }
  Wait-Forgejo
  Verify-Forgejo
}

function Uninstall-ForgejoAutomation {
  Write-Step 'Removing CAP polling credentials and restoring GitHub origin remotes'
  foreach ($project in @('codex-acceptance-platform', 'atmosphere-engine')) {
    try { Invoke-Cap @('automation', 'forgejo', 'uninstall', '--project', $project) | Out-Host } catch { Write-Warning $_ }
  }
  foreach ($root in @($CapRoot, $AtmosphereRoot)) {
    $remotes = @(& git -C $root remote)
    if ($remotes -contains 'github') {
      & git -C $root remote set-url origin (& git -C $root remote get-url github)
    }
  }
  $removeCron = "if grep -q CAP_FORGEJO_BACKUP /etc/crontab; then cp /etc/crontab $NasRoot/backups/crontab.uninstall.`$(date +%Y%m%d-%H%M%S).bak; sed -i '/CAP_FORGEJO_BACKUP/d' /etc/crontab; synosystemctl restart crond >/dev/null 2>&1 || true; fi"
  Invoke-Nas "sudo -n sh -c '$removeCron'" | Out-Null
  Write-Host 'Forgejo service and all repository/data/backup history were preserved.'
}

switch ($Action) {
  'install' { Install-Forgejo }
  'verify' { Verify-Forgejo }
  'backup' { Backup-Forgejo }
  'restore' { Restore-Forgejo }
  'uninstall' { Uninstall-ForgejoAutomation }
}
