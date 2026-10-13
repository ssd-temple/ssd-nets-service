# Loads the pre-compiled RawPrinterHelper.dll instead of compiling the C#
# helper from source on every invocation. Add-Type -TypeDefinition (the
# previous approach) invokes the full .NET compiler fresh every time this
# script runs -- measured at ~1.5s per print job on its own, which was the
# dominant chunk of the delay between payment confirmation and the ticket
# coming out. Add-Type -Path (loading an already-built assembly) is just a
# file load, no compilation, cutting that ~1.5s to near-zero. The actual
# printing logic (WritePrinter Win32 API calls) is byte-for-byte identical
# to before -- see RawPrinterHelper.cs, the source this DLL was built from
# (csc.exe /target:library RawPrinterHelper.cs) -- only how the code gets
# loaded into this process changed, not what it does.
$dllPath = Join-Path $PSScriptRoot 'RawPrinterHelper.dll'
Add-Type -Path $dllPath

$PrinterName = $args[0]
$FilePath = $args[1]

if (-not $PrinterName -or -not $FilePath) {
    Write-Host "Usage: Send-RawPrint.ps1 <PrinterName> <FilePath>"
    exit 1
}

Write-Host "Sending $FilePath to $PrinterName..."
$result = [RawPrinterHelper]::SendFileToPrinter($PrinterName, $FilePath)

if ($result) {
    Write-Host "Success"
} else {
    Write-Host "Failed"
    exit 1
}
