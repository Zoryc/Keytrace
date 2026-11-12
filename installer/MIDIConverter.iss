; MIDI Converter - small online installer (Inno Setup 6).
;
; Build with installer\build.ps1, which stages the files and passes:
;   /DAppVersion=0.1.0 /DNumVersion=0.1.0.0 /DStageDir=...\build\stage /DOutputDir=...\dist /DIconFile=...\MIDIConverter.ico
;
; The setup copies the launcher, uv and the app's source files (~40 MB), then runs
;   "{app}\MIDI Converter.exe" --setup --quiet [--with-aria] [--unattended (silent installs)]
; which downloads Python, PyTorch and the packages (~3 GB) in its own window.
;
; Extra command-line switch: /SKIPRUNTIME  install the files only; the component download then
; happens the first time MIDI Converter is opened.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef NumVersion
  #define NumVersion "0.0.0.0"
#endif
#ifndef StageDir
  #define StageDir "build\stage"
#endif
#ifndef OutputDir
  #define OutputDir "dist"
#endif
#ifndef IconFile
  #define IconFile "assets\MIDIConverter.ico"
#endif

#define AppName "MIDI Converter"
#define AppExeName "MIDI Converter.exe"
#define AppUserModelID "MIDIConverter.Desktop"

[Setup]
AppId={{297B4DF5-B5E6-4E80-A45C-E0E226FC35DC}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\assets\MIDIConverter.ico
VersionInfoVersion={#NumVersion}
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#NumVersion}
VersionInfoProductTextVersion={#AppVersion}
VersionInfoDescription={#AppName} Setup

; Per-user by default ({localappdata}\Programs\MIDI Converter); the dialog offers "all users" too.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DefaultDirName={autopf}\{#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0

; Python + PyTorch + packages are downloaded after the files are copied (about 3 GB installed,
; plus the download cache while installing).
ExtraDiskSpaceRequired=7000000000

; Inno Setup 6.7+ turns on Windows' RedirectionGuard by default, and child processes inherit it.
; uv links Python 3.13 to its patch version with an NTFS junction (python\cpython-3.13-...), and the
; venv's python.exe goes through that junction: under RedirectionGuard both "uv python install"
; (OS error 448) and the app started from the last page fail. The default install is per-user and
; {app} is only writable by its owner, so the mitigation adds little here.
RedirectionGuard=no

; The desktop app holds this mutex while it runs: setup and uninstall ask to close it first.
AppMutex=MIDIConverter.SingleInstance
SetupMutex=MIDIConverterSetupMutex

WizardStyle=modern
SetupIconFile={#IconFile}
OutputDir={#OutputDir}
OutputBaseFilename=MIDI-Converter-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
ShowLanguageDialog=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
ReadyLabel2a=Setup is now ready to install [name] on your computer.%n%nDuring the installation, Setup downloads Python, PyTorch and the transcription components (about 3 GB), so keep this computer connected to the internet.%n%nClick Install to continue, or click Back to review or change any settings.
ReadyLabel2b=Setup is now ready to install [name] on your computer.%n%nDuring the installation, Setup downloads Python, PyTorch and the transcription components (about 3 GB), so keep this computer connected to the internet.%n%nClick Install to continue.

[Types]
Name: "custom"; Description: "Custom installation"; Flags: iscustom

[Components]
Name: "main"; Description: "MIDI Converter (downloads about 3 GB of components during setup)"; Types: custom; Flags: fixed
Name: "aria"; Description: "Ensemble mode with Aria-AMT, the most accurate setting (downloads ~450 MB more; non-commercial license)"; Types: custom; ExtraDiskSpaceRequired: 1000000000

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"
Name: "contextmenu"; Description: "Add ""Convert to MIDI"" to the right-click menu of audio and video files"; GroupDescription: "Additional shortcuts:"

[Registry]
; Explorer verb for every file Windows perceives as audio or video ("Show more options" on Windows 11).
Root: HKA; Subkey: "Software\Classes\SystemFileAssociations\audio\shell\MIDIConverter"; ValueType: string; ValueName: ""; ValueData: "Convert to MIDI"; Flags: uninsdeletekey; Tasks: contextmenu
Root: HKA; Subkey: "Software\Classes\SystemFileAssociations\audio\shell\MIDIConverter"; ValueType: string; ValueName: "Icon"; ValueData: """{app}\assets\MIDIConverter.ico"""; Tasks: contextmenu
Root: HKA; Subkey: "Software\Classes\SystemFileAssociations\audio\shell\MIDIConverter\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExeName}"" ""%1"""; Tasks: contextmenu
Root: HKA; Subkey: "Software\Classes\SystemFileAssociations\video\shell\MIDIConverter"; ValueType: string; ValueName: ""; ValueData: "Convert to MIDI"; Flags: uninsdeletekey; Tasks: contextmenu
Root: HKA; Subkey: "Software\Classes\SystemFileAssociations\video\shell\MIDIConverter"; ValueType: string; ValueName: "Icon"; ValueData: """{app}\assets\MIDIConverter.ico"""; Tasks: contextmenu
Root: HKA; Subkey: "Software\Classes\SystemFileAssociations\video\shell\MIDIConverter\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExeName}"" ""%1"""; Tasks: contextmenu

[InstallDelete]
; Start from a clean copy of the app's code on upgrades (keeps runtime, python and models).
Type: filesandordirs; Name: "{app}\app\midiconv"
Type: filesandordirs; Name: "{app}\app\web"
Type: filesandordirs; Name: "{app}\app\scripts"

[Files]
Source: "{#StageDir}\{#AppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\tools\uv.exe"; DestDir: "{app}\tools"; Flags: ignoreversion
Source: "{#StageDir}\assets\*"; DestDir: "{app}\assets"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\assets\MIDIConverter.ico"; AppUserModelID: "{#AppUserModelID}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\assets\MIDIConverter.ico"; AppUserModelID: "{#AppUserModelID}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Launch {#AppName}"; Flags: postinstall skipifsilent nowait

[UninstallDelete]
; Everything the setup window and the app created next to the installed files.
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\python"
Type: filesandordirs; Name: "{app}\.uv-cache"
Type: filesandordirs; Name: "{app}\app\models"
Type: filesandordirs; Name: "{app}\app"
Type: files; Name: "{app}\setup.log"
Type: files; Name: "{app}\setup-options.txt"
Type: dirifempty; Name: "{app}\tools"
Type: dirifempty; Name: "{app}\assets"
Type: dirifempty; Name: "{app}"

[Code]
var
  DeleteUserData: Boolean;

function HasSwitch(const Name: String): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), Name) = 0 then
    begin
      Result := True;
      Exit;
    end;
end;

{ Download Python, PyTorch and the packages with the launcher's setup window. Not fatal:
  if it fails or is cancelled, the app finishes the setup the next time it is opened. }
procedure RunComponentSetup;
var
  Params, Msg: String;
  ResultCode: Integer;
  Started: Boolean;
begin
  Params := '--setup --quiet';
  if WizardIsComponentSelected('aria') then
    Params := Params + ' --with-aria';
  { /SILENT and /VERYSILENT: the setup window also closes by itself when the download fails, instead of
    waiting for Retry or Close (an unattended install would otherwise never finish). }
  if WizardSilent then
    Params := Params + ' --unattended';

  WizardForm.StatusLabel.Caption := 'Downloading Python, PyTorch and the app components (about 3 GB)...';
  WizardForm.FilenameLabel.Caption := 'Progress is shown in the MIDI Converter Setup window. This can take a while.';
  WizardForm.ProgressGauge.Style := npbstMarquee;
  try
    Log('Running: "' + ExpandConstant('{app}\{#AppExeName}') + '" ' + Params);
    Started := Exec(ExpandConstant('{app}\{#AppExeName}'), Params, ExpandConstant('{app}'),
                    SW_SHOWNORMAL, ewWaitUntilTerminated, ResultCode);
  finally
    WizardForm.ProgressGauge.Style := npbstNormal;
  end;

  if Started and (ResultCode = 0) then
  begin
    Log('Components installed.');
    Exit;
  end;

  if not Started then
  begin
    Log('Could not start the component setup: ' + SysErrorMessage(ResultCode));
    Msg := 'Setup could not start the download of MIDI Converter''s components (Python and PyTorch).';
  end
  else if ResultCode = 2 then
  begin
    Log('Component setup cancelled by the user.');
    Msg := 'The download of MIDI Converter''s components (Python and PyTorch) was cancelled.';
  end
  else
  begin
    Log(Format('Component setup failed with exit code %d.', [ResultCode]));
    Msg := 'MIDI Converter''s components (Python and PyTorch) could not be downloaded.';
  end;
  SuppressibleMsgBox(Msg + #13#10#13#10 +
    'MIDI Converter is installed. It will finish the setup the next time you open it.' + #13#10 +
    'Details are in ' + ExpandConstant('{app}\setup.log') + '.',
    mbInformation, MB_OK, IDOK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    if HasSwitch('/SKIPRUNTIME') then
      Log('/SKIPRUNTIME: skipping the component download.')
    else
      RunComponentSetup;
  end;
end;

{ Delete a folder created by the setup window. rd handles uv's junctions (without following them)
  and paths longer than 260 characters (deep PyTorch files), which [UninstallDelete] cannot. }
procedure RemoveTree(const Dir: String);
var
  ResultCode: Integer;
begin
  if not DirExists(Dir) then
    Exit;
  if Exec(ExpandConstant('{cmd}'), '/c rd /s /q "\\?\' + Dir + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Log(Format('rd "%s": exit code %d', [Dir, ResultCode]))
  else
    Log('Could not run rd for ' + Dir);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  DataDir := ExpandConstant('{localappdata}\MIDI Converter');
  if CurUninstallStep = usUninstall then
  begin
    RemoveTree(ExpandConstant('{app}\runtime'));
    RemoveTree(ExpandConstant('{app}\python'));
    RemoveTree(ExpandConstant('{app}\.uv-cache'));
    RemoveTree(ExpandConstant('{app}\app\models'));
    DeleteUserData := False;
    if DirExists(DataDir) and not UninstallSilent then
      DeleteUserData := MsgBox('Do you also want to delete your MIDI Converter conversion history and settings?' + #13#10#13#10 +
                               DataDir, mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
  end
  else if (CurUninstallStep = usPostUninstall) and DeleteUserData then
  begin
    if DelTree(DataDir, True, True, True) then
      Log('Deleted ' + DataDir)
    else
      Log('Could not delete ' + DataDir);
  end;
end;
