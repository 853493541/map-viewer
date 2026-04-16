param(
  [Parameter(Mandatory = $true)]
  [string]$LogicalPath,

  [string]$CacheRoot = 'C:\SeasunGame\Game\JX3\bin\zhcn_hd\SeasunDownloaderV2.4\seasun\zscache\dat',

  [string]$OutputPath,

  [switch]$InfoOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$lzhamDllPath = 'C:\SeasunGame\Game\JX3\bin\zhcn_hd\SeasunDownloaderV2.4\seasun\editortool\qseasuneditor\seasunapp\httppacking\lzham_x64.dll'

if (-not ('Jx3CacheNative' -as [type])) {
  $escapedDllPath = $lzhamDllPath.Replace('\', '\\')
  $typeDefinition = @"
using System;
using System.Runtime.InteropServices;

public static class Jx3CacheNative
{
    private const ulong PRIME64_1 = 0x9E3779B185EBCA87UL;
    private const ulong PRIME64_2 = 0xC2B2AE3D27D4EB4FUL;
    private const ulong PRIME64_3 = 0x165667B19E3779F9UL;
    private const ulong PRIME64_4 = 0x85EBCA77C2B2AE63UL;
    private const ulong PRIME64_5 = 0x27D4EB2F165667C5UL;

    private static ulong RotateLeft(ulong value, int count)
    {
        return (value << count) | (value >> (64 - count));
    }

    private static ulong Round(ulong acc, ulong input)
    {
        unchecked
        {
            acc += input * PRIME64_2;
            acc = RotateLeft(acc, 31);
            acc *= PRIME64_1;
            return acc;
        }
    }

    private static ulong MergeRound(ulong acc, ulong value)
    {
        unchecked
        {
            acc ^= Round(0UL, value);
            acc = acc * PRIME64_1 + PRIME64_4;
            return acc;
        }
    }

    public static uint Djb2Masked(byte[] data)
    {
        uint hash = 5381U;
        unchecked
        {
            foreach (byte value in data)
            {
                hash = ((hash * 33U) + value) & 0x3FFFFFU;
            }
        }
        return hash;
    }

    public static ulong ComposeH2(uint dirHash, ulong fullPathHash)
    {
        return ((ulong)dirHash << 40) | (fullPathHash & 0xFFFFFFFFFFUL);
    }

    public static ulong XxHash64(byte[] data)
    {
        if (data == null)
        {
          throw new ArgumentNullException("data");
        }

        int length = data.Length;
        int offset = 0;
        ulong hash;

        unchecked
        {
            if (length >= 32)
            {
                ulong v1 = PRIME64_1 + PRIME64_2;
                ulong v2 = PRIME64_2;
                ulong v3 = 0UL;
                ulong v4 = unchecked(0UL - PRIME64_1);
                int limit = length - 32;

                while (offset <= limit)
                {
                    v1 = Round(v1, BitConverter.ToUInt64(data, offset));
                    offset += 8;
                    v2 = Round(v2, BitConverter.ToUInt64(data, offset));
                    offset += 8;
                    v3 = Round(v3, BitConverter.ToUInt64(data, offset));
                    offset += 8;
                    v4 = Round(v4, BitConverter.ToUInt64(data, offset));
                    offset += 8;
                }

                hash = RotateLeft(v1, 1) + RotateLeft(v2, 7) + RotateLeft(v3, 12) + RotateLeft(v4, 18);
                hash = MergeRound(hash, v1);
                hash = MergeRound(hash, v2);
                hash = MergeRound(hash, v3);
                hash = MergeRound(hash, v4);
            }
            else
            {
                hash = PRIME64_5;
            }

            hash += (ulong)length;

            while (offset <= length - 8)
            {
                ulong lane = Round(0UL, BitConverter.ToUInt64(data, offset));
                hash ^= lane;
                hash = RotateLeft(hash, 27) * PRIME64_1 + PRIME64_4;
                offset += 8;
            }

            if (offset <= length - 4)
            {
                hash ^= (ulong)BitConverter.ToUInt32(data, offset) * PRIME64_1;
                hash = RotateLeft(hash, 23) * PRIME64_2 + PRIME64_3;
                offset += 4;
            }

            while (offset < length)
            {
                hash ^= (ulong)data[offset] * PRIME64_5;
                hash = RotateLeft(hash, 11) * PRIME64_1;
                offset += 1;
            }

            hash ^= hash >> 33;
            hash *= PRIME64_2;
            hash ^= hash >> 29;
            hash *= PRIME64_3;
            hash ^= hash >> 32;
        }

        return hash;
    }

    [DllImport("$escapedDllPath", CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
    public static extern int lzham_z_uncompress(byte[] dest, ref uint destLen, byte[] src, uint srcLen);
}
"@
  Add-Type -TypeDefinition $typeDefinition
}

function Normalize-LogicalPath {
  param([string]$PathLike)
  return $PathLike.Replace('\\', '/').Trim().ToLowerInvariant()
}

function Resolve-H1FromFn {
  param(
    [string]$Root,
    [UInt64]$H2
  )

  $fnFiles = Get-ChildItem -Path $Root -File -Filter 'fn*.1' | Sort-Object Name
  foreach ($fnFile in $fnFiles) {
    $bytes = [System.IO.File]::ReadAllBytes($fnFile.FullName)
    for ($offset = 4; $offset + 20 -le $bytes.Length; $offset += 20) {
      $entryH1 = [BitConverter]::ToUInt64($bytes, $offset)
      $entryH2 = [BitConverter]::ToUInt64($bytes, $offset + 8)
      if ($entryH2 -ne $H2) {
        continue
      }

      return [pscustomobject]@{
        H1 = $entryH1
        H2 = $entryH2
        FnFile = $fnFile.FullName
        FnOffset = $offset
        Chain = [BitConverter]::ToUInt32($bytes, $offset + 16)
      }
    }
  }

  return $null
}

function Resolve-IdxEntry {
  param(
    [string]$Root,
    [UInt64]$H1
  )

  $idxPath = Join-Path $Root '0.idx'
  $bytes = [System.IO.File]::ReadAllBytes($idxPath)
  for ($offset = 36; $offset + 36 -le $bytes.Length; $offset += 36) {
    $entryH1 = [BitConverter]::ToUInt64($bytes, $offset)
    if ($entryH1 -ne $H1) {
      continue
    }

    $meta = [BitConverter]::ToUInt32($bytes, $offset + 32)
    return [pscustomobject]@{
      H1 = $entryH1
      Offset = [BitConverter]::ToUInt64($bytes, $offset + 8)
      OriginalSize = [BitConverter]::ToUInt32($bytes, $offset + 16)
      CompressedSize = [BitConverter]::ToUInt32($bytes, $offset + 20)
      Sequence = [BitConverter]::ToUInt32($bytes, $offset + 24)
      Blocks = [BitConverter]::ToUInt32($bytes, $offset + 28)
      Meta = $meta
      CompressionType = $meta -band 0xFF
      DatIndex = ($meta -shr 12) -band 0xF
      IdxOffset = $offset
      IdxPath = $idxPath
    }
  }

  return $null
}

function Read-DatEntryBytes {
  param(
    [string]$Root,
    [pscustomobject]$IndexEntry
  )

  $datPath = Join-Path $Root ("{0}.dat" -f $IndexEntry.DatIndex)
  if (-not (Test-Path $datPath)) {
    throw "DAT file not found: $datPath"
  }

  $buffer = New-Object byte[] $IndexEntry.CompressedSize
  $stream = [System.IO.File]::OpenRead($datPath)
  try {
    $null = $stream.Seek([int64]$IndexEntry.Offset, [System.IO.SeekOrigin]::Begin)
    $read = $stream.Read($buffer, 0, $buffer.Length)
    if ($read -ne $buffer.Length) {
      throw "Expected $($buffer.Length) bytes from $datPath but read $read"
    }
  }
  finally {
    $stream.Dispose()
  }

  return [pscustomobject]@{
    DatPath = $datPath
    Bytes = $buffer
  }
}

function Expand-LzhamEntry {
  param(
    [byte[]]$CompressedEntry,
    [UInt32]$OriginalSize
  )

  if ($CompressedEntry.Length -lt 20) {
    throw 'Compressed cache entry is too small to contain the 20-byte header'
  }

  $payloadLength = $CompressedEntry.Length - 20
  $payload = New-Object byte[] $payloadLength
  [Array]::Copy($CompressedEntry, 20, $payload, 0, $payloadLength)

  $output = New-Object byte[] $OriginalSize
  $destLen = [UInt32]$OriginalSize
  $status = [Jx3CacheNative]::lzham_z_uncompress($output, [ref]$destLen, $payload, [UInt32]$payload.Length)
  if ($status -ne 0) {
    throw "lzham_z_uncompress failed with status $status"
  }

  if ($destLen -eq $OriginalSize) {
    return $output
  }

  $trimmed = New-Object byte[] $destLen
  [Array]::Copy($output, 0, $trimmed, 0, $destLen)
  return $trimmed
}

if (-not (Test-Path $CacheRoot)) {
  throw "Cache root not found: $CacheRoot"
}
if (-not (Test-Path $lzhamDllPath)) {
  throw "LZHAM DLL not found: $lzhamDllPath"
}

$normalizedPath = Normalize-LogicalPath $LogicalPath
$slashIndex = $normalizedPath.LastIndexOf('/')
if ($slashIndex -lt 0) {
  throw 'LogicalPath must include at least one parent directory'
}

$parentPath = $normalizedPath.Substring(0, $slashIndex)
$gbk = [System.Text.Encoding]::GetEncoding(936)
$fullPathBytes = $gbk.GetBytes($normalizedPath)
$parentBytes = $gbk.GetBytes($parentPath)

$dirHash = [Jx3CacheNative]::Djb2Masked($parentBytes)
$fileHash = [Jx3CacheNative]::XxHash64($fullPathBytes)
$h2 = [Jx3CacheNative]::ComposeH2($dirHash, $fileHash)

$fnEntry = Resolve-H1FromFn -Root $CacheRoot -H2 $h2
if ($null -eq $fnEntry) {
  throw "No FN mapping found for $normalizedPath"
}

$idxEntry = Resolve-IdxEntry -Root $CacheRoot -H1 $fnEntry.H1
if ($null -eq $idxEntry) {
  throw "No IDX entry found for h1=$($fnEntry.H1)"
}

$result = [ordered]@{
  logicalPath = $normalizedPath
  parentPath = $parentPath
  dirHash = ('0x{0:X}' -f $dirHash)
  xxh64 = ('0x{0:X16}' -f $fileHash)
  h2 = ('0x{0:X16}' -f $h2)
  h1 = ('0x{0:X16}' -f $fnEntry.H1)
  fnFile = $fnEntry.FnFile
  idxPath = $idxEntry.IdxPath
  datIndex = $idxEntry.DatIndex
  datOffset = $idxEntry.Offset
  compressedSize = $idxEntry.CompressedSize
  originalSize = $idxEntry.OriginalSize
  compressionType = $idxEntry.CompressionType
}

if ($InfoOnly) {
  $result | ConvertTo-Json -Depth 4
  return
}

$entryData = Read-DatEntryBytes -Root $CacheRoot -IndexEntry $idxEntry
$outputBytes = switch ($idxEntry.CompressionType) {
  10 { Expand-LzhamEntry -CompressedEntry $entryData.Bytes -OriginalSize $idxEntry.OriginalSize }
  0 { $entryData.Bytes }
  default { throw "Unsupported compression type: $($idxEntry.CompressionType)" }
}

if (-not $OutputPath) {
  $OutputPath = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetFileName($normalizedPath))
}

$outputFullPath = if ([System.IO.Path]::IsPathRooted($OutputPath)) {
  $OutputPath
}
else {
  [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $OutputPath))
}

$outputDirectory = Split-Path -Path $outputFullPath -Parent
if ($outputDirectory) {
  [System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
}

[System.IO.File]::WriteAllBytes($outputFullPath, $outputBytes)
$result.outputPath = $outputFullPath
$result.outputSize = $outputBytes.Length
$result | ConvertTo-Json -Depth 4