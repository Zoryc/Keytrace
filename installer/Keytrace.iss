; Keytrace - small online installer (Inno Setup 6).
;
; Build with installer\build.ps1, which stages the files and passes:
;   /DAppVersion=0.2.0 /DNumVersion=0.2.0.0 /DStageDir=...\build\stage /DOutputDir=...\dist /DIconFile=...\Keytrace.ico
;
; The setup copies the launcher, uv and the app's source files (~40 MB), then runs
;   "{app}\Keytrace.exe" --setup --quiet [--with-aria] [--unattended (silent installs)]
; which downloads Python, PyTorch and the packages (~3 GB) in its own window.
;
; Extra command-line switch: /SKIPRUNTIME  install the files only; the component download then
; happens the first time Keytrace is opened.
;
; A first install needs a new or empty folder (or a previous Keytrace install): the setup window
; creates, and the uninstaller deletes, folders with generic names there (app, python, runtime, .uv-cache).
;
; Keytrace was called "MIDI Converter" up to 0.1.0. The AppId is unchanged, so this setup upgrades such an
; install in place (in its folder): it removes the old launcher, icon, shortcuts and Explorer verb, and the
; uninstaller also offers to delete the old user data folder (%LOCALAPPDATA%\MIDI Converter).

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
  #define IconFile "assets\Keytrace.ico"
#endif

#define AppName "Keytrace"
#define AppExeName "Keytrace.exe"
#define AppIconName "Keytrace.ico"
#define AppUserModelID "Keytrace.Desktop"
; The Explorer verb's registry key (Software\Classes\SystemFileAssociations\<audio|video>\shell\<key>).
#define VerbKey "Keytrace"
#define VerbLabel "Convert to MIDI with Keytrace"

; What 0.1.0 ("MIDI Converter") installed under other names: removed when it is upgraded.
#define LegacyName "MIDI Converter"
#define LegacyExeName "MIDI Converter.exe"
#define LegacyIconName "MIDIConverter.ico"
#define LegacyVerbKey "MIDIConverter"

[Setup]
; Unchanged since MIDI Converter 0.1.0: Keytrace upgrades it.
AppId={{297B4DF5-B5E6-4E80-A45C-E0E226FC35DC}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\assets\{#AppIconName}
VersionInfoVersion={#NumVersion}
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#NumVersion}
VersionInfoProductTextVersion={#AppVersion}
VersionInfoDescription={#AppName} Setup

; Per-user by default ({localappdata}\Programs\Keytrace); the dialog offers "all users" too. An upgrade
; keeps the folder of the previous install (UsePreviousAppDir), also one named "MIDI Converter".
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DefaultDirName={autopf}\{#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
; The folder check in [Code] (IsForeignNonEmptyDir) replaces Inno's "folder already exists, install anyway?"
; question: a new or empty folder is fine, a folder with other files is refused.
DirExistsWarning=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0

; Python + PyTorch + packages are downloaded after the files are copied (about 3 GB downloaded,
; about 5 GB installed, plus the download cache while installing).
ExtraDiskSpaceRequired=7000000000

; Inno Setup 6.7+ turns on Windows' RedirectionGuard by default, and child processes inherit it.
; uv links Python 3.13 to its patch version with an NTFS junction (python\cpython-3.13-...), and the
; venv's python.exe goes through that junction: under RedirectionGuard both "uv python install"
; (OS error 448) and the app started from the last page fail. The default install is per-user and
; {app} is only writable by its owner, so the mitigation adds little here.
RedirectionGuard=no

; The desktop app holds this mutex while it runs: setup and uninstall ask to close it first. The second
; name is the mutex of MIDI Converter 0.1.0, which may still be running when it is upgraded.
AppMutex=Keytrace.SingleInstance,MIDIConverter.SingleInstance
SetupMutex=KeytraceSetupMutex

WizardStyle=modern
SetupIconFile={#IconFile}
OutputDir={#OutputDir}
OutputBaseFilename=Keytrace-Setup-{#AppVersion}
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
Name: "main"; Description: "Keytrace (downloads about 3 GB of components during setup)"; Types: custom; Flags: fixed
Name: "aria"; Description: "Ensemble mode with Aria-AMT, the most accurate setting (downloads ~450 MB more; non-commercial license)"; Types: custom; ExtraDiskSpaceRequired: 1000000000

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"
Name: "contextmenu"; Description: "Add ""{#VerbLabel}"" to the right-click menu of audio and video files"; GroupDescription: "Additional shortcuts:"

[Registry]
; MIDI Converter 0.1.0's verb ("Convert to MIDI"), which started the old launcher: removed on every install.
Root: HKA; Subkey: "Software\Classes\SystemFileAssociations\audio\shell\{#LegacyVerbKey}"; ValueType: none; Flags: deletekey
Root: HKA; Subkey: "Software\Classes\SystemFileAssociations\video\shell\{#LegacyVerbKey}"; ValueType: none; Flags: deletekey
; Explorer verb for every file Windows perceives as audio or video ("Show more options" on Windows 11).
Root: HKA; Subkey: "Software\Classes\SystemFileAssociations\audio\shell\{#VerbKey}"; ValueType: string; ValueName: ""; ValueData: "{#VerbLabel}"; Flags: uninsdeletekey; Tasks: contextmenu
Root: HKA; Subkey: "Software\Classes\SystemFileAssociations\audio\shell\{#VerbKey}"; ValueType: string; ValueName: "Icon"; ValueData: """{app}\assets\{#AppIconName}"""; Tasks: contextmenu
Root: HKA; Subkey: "Software\Classes\SystemFileAssociations\audio\shell\{#VerbKey}\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExeName}"" ""%1"""; Tasks: contextmenu
Root: HKA; Subkey: "Software\Classes\SystemFileAssociations\video\shell\{#VerbKey}"; ValueType: string; ValueName: ""; ValueData: "{#VerbLabel}"; Flags: uninsdeletekey; Tasks: contextmenu
Root: HKA; Subkey: "Software\Classes\SystemFileAssociations\video\shell\{#VerbKey}"; ValueType: string; ValueName: "Icon"; ValueData: """{app}\assets\{#AppIconName}"""; Tasks: contextmenu
Root: HKA; Subkey: "Software\Classes\SystemFileAssociations\video\shell\{#VerbKey}\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExeName}"" ""%1"""; Tasks: contextmenu

[InstallDelete]
; Start from a clean copy of the app's code on upgrades (keeps runtime, python and models).
Type: filesandordirs; Name: "{app}\app\midiconv"
Type: filesandordirs; Name: "{app}\app\web"
Type: filesandordirs; Name: "{app}\app\scripts"
; Upgrade from MIDI Converter 0.1.0: its launcher, icon and shortcuts (the new ones are named Keytrace).
Type: files; Name: "{app}\{#LegacyExeName}"
Type: files; Name: "{app}\assets\{#LegacyIconName}"
Type: files; Name: "{autoprograms}\{#LegacyName}.lnk"
Type: files; Name: "{autodesktop}\{#LegacyName}.lnk"

[Files]
Source: "{#StageDir}\{#AppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\tools\uv.exe"; DestDir: "{app}\tools"; Flags: ignoreversion
Source: "{#StageDir}\assets\*"; DestDir: "{app}\assets"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\assets\{#AppIconName}"; AppUserModelID: "{#AppUserModelID}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\assets\{#AppIconName}"; AppUserModelID: "{#AppUserModelID}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Launch {#AppName}"; Flags: postinstall skipifsilent nowait

[UninstallDelete]
; What the setup window and the app created next to the installed files. runtime, python and .uv-cache
; are removed in [Code] (RemoveSetupFolder), and only when they carry the marks of Keytrace's setup.
; Only the app's own subfolders of {app}\app are removed (with the __pycache__ folders Python adds).
Type: filesandordirs; Name: "{app}\app\midiconv"
Type: filesandordirs; Name: "{app}\app\web"
Type: filesandordirs; Name: "{app}\app\scripts"
Type: filesandordirs; Name: "{app}\app\models\aria-amt"
Type: dirifempty; Name: "{app}\app\models"
Type: dirifempty; Name: "{app}\app"
Type: files; Name: "{app}\setup.log"
Type: files; Name: "{app}\setup-options.txt"
Type: dirifempty; Name: "{app}\tools"
Type: dirifempty; Name: "{app}\assets"
Type: dirifempty; Name: "{app}"

[Code]
const
  ContextMenuAudioKey = 'Software\Classes\SystemFileAssociations\audio\shell\{#VerbKey}';
  ContextMenuVideoKey = 'Software\Classes\SystemFileAssociations\video\shell\{#VerbKey}';

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

{ ---- install folder ---- }

function IsDirEmpty(const Dir: String): Boolean;
var
  FindRec: TFindRec;
begin
  Result := True;
  if FindFirst(AddBackslash(Dir) + '*', FindRec) then
  try
    repeat
      if (FindRec.Name <> '.') and (FindRec.Name <> '..') then
        Result := False;
    until (not Result) or (not FindNext(FindRec));
  finally
    FindClose(FindRec);
  end;
end;

{ A Keytrace (or MIDI Converter 0.1.0) install, possibly without its uninstall entry (e.g. a broken earlier install). }
function LooksLikeOurInstall(const Dir: String): Boolean;
begin
  Result := (FileExists(AddBackslash(Dir) + '{#AppExeName}') or FileExists(AddBackslash(Dir) + '{#LegacyExeName}'))
            and FileExists(AddBackslash(Dir) + 'tools\uv.exe');
end;

{ True when Dir is a folder with other files in it: not new, not empty, not a Keytrace install.
  The setup window creates, and the uninstaller deletes, folders with generic names in the install
  folder (app, python, runtime, .uv-cache), so Keytrace must not share its folder with anything else. }
function IsForeignNonEmptyDir(const Dir: String): Boolean;
var
  D: String;
begin
  Result := False;
  D := RemoveBackslashUnlessRoot(Dir);
  if (WizardForm.PrevAppDir <> '') and (CompareText(RemoveBackslashUnlessRoot(WizardForm.PrevAppDir), D) = 0) then
    Exit;
  if not DirExists(D) then
    Exit;
  if LooksLikeOurInstall(D) then
    Exit;
  Result := not IsDirEmpty(D);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Dir, Suggested: String;
begin
  Result := True;
  { Interactive installs: offer a subfolder. Silent installs stop in PrepareToInstall instead. }
  if (CurPageID = wpSelectDir) and not WizardSilent then
  begin
    Dir := RemoveBackslashUnlessRoot(WizardDirValue);
    if IsForeignNonEmptyDir(Dir) then
    begin
      Suggested := AddBackslash(Dir) + '{#AppName}';
      Log('The selected folder is not empty: ' + Dir);
      MsgBox('The folder' + #13#10 + Dir + #13#10 + 'already contains other files.' + #13#10#13#10 +
             'Keytrace needs a folder of its own: it creates folders named app, python and runtime in it, ' +
             'and deletes them again when it is uninstalled.' + #13#10#13#10 +
             'Setup has changed the folder to' + #13#10 + Suggested + #13#10 +
             'Click Next to use it, or choose another new or empty folder.', mbError, MB_OK);
      WizardForm.DirEdit.Text := Suggested;
      Result := False;
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Dir: String;
begin
  Result := '';
  Dir := RemoveBackslashUnlessRoot(WizardDirValue);
  if IsForeignNonEmptyDir(Dir) then
  begin
    Result := 'The folder ' + Dir + ' already contains other files. Keytrace needs a new or empty folder ' +
              '(for example ' + AddBackslash(Dir) + '{#AppName}), because it creates folders named app, python ' +
              'and runtime in it and deletes them again when it is uninstalled.';
    Log('Not installing: ' + Result);
  end;
end;

{ ---- after the files are copied ---- }

{ The launcher's setup-options.txt (same format as AppPaths.SaveWithAria): a repair started by the app,
  e.g. after /SKIPRUNTIME, installs the components selected here. }
procedure SaveComponentOptions;
var
  Value: String;
begin
  if WizardIsComponentSelected('aria') then
    Value := '1'
  else
    Value := '0';
  if SaveStringToFile(ExpandConstant('{app}\setup-options.txt'),
       '# Written by Keytrace''s setup; used when it has to finish the setup again.' + #13#10 +
       'with-aria=' + Value + #13#10, False) then
    Log('setup-options.txt: with-aria=' + Value)
  else
    Log('Could not write ' + ExpandConstant('{app}\setup-options.txt'));
end;

{ A modify or upgrade can untick what an earlier install added. }
procedure RemoveDeselected;
var
  Models: String;
begin
  if not WizardIsComponentSelected('aria') then
  begin
    { Without its weights the app no longer offers Aria-AMT (nor the Ensemble mode). The component setup
      (setup_runtime.py without --with-aria) also uninstalls its packages, now or at the next repair. }
    Models := ExpandConstant('{app}\app\models\aria-amt');
    if DirExists(Models) then
    begin
      if DelTree(Models, True, True, True) then
        Log('Aria-AMT not selected: deleted ' + Models)
      else
        Log('Aria-AMT not selected: could not delete ' + Models);
    end;
  end;
  if not WizardIsTaskSelected('contextmenu') then
  begin
    if RegKeyExists(HKA, ContextMenuAudioKey) then
    begin
      RegDeleteKeyIncludingSubkeys(HKA, ContextMenuAudioKey);
      Log('Context menu not selected: removed ' + ContextMenuAudioKey);
    end;
    if RegKeyExists(HKA, ContextMenuVideoKey) then
    begin
      RegDeleteKeyIncludingSubkeys(HKA, ContextMenuVideoKey);
      Log('Context menu not selected: removed ' + ContextMenuVideoKey);
    end;
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
  WizardForm.FilenameLabel.Caption := 'Progress is shown in the "Setting up Keytrace" window. This can take a while.';
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
    Msg := 'Setup could not start the download of Keytrace''s components (Python and PyTorch).';
  end
  else if ResultCode = 2 then
  begin
    Log('Component setup cancelled by the user.');
    Msg := 'The download of Keytrace''s components (Python and PyTorch) was cancelled.';
  end
  else
  begin
    Log(Format('Component setup failed with exit code %d.', [ResultCode]));
    Msg := 'Keytrace''s components (Python and PyTorch) could not be downloaded.';
  end;
  Msg := Msg + #13#10#13#10 +
    'Keytrace is installed. It will finish the setup the next time you open it.' + #13#10 +
    'Details are in ' + ExpandConstant('{app}\setup.log') + '.';
  Log(Msg);
  { A silent install must not wait for a click (the launcher's window already closed by itself). }
  if not WizardSilent then
    SuppressibleMsgBox(Msg, mbInformation, MB_OK, IDOK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Marker: String;
begin
  if CurStep = ssPostInstall then
  begin
    SaveComponentOptions;
    RemoveDeselected;
    { The runtime no longer matches the new app files or the new selection: until the component setup
      writes the marker again, opening the app finishes (repairs) the setup first. }
    Marker := ExpandConstant('{app}\runtime\midiconv-ready.txt');
    if FileExists(Marker) then
    begin
      if DeleteFile(Marker) then
        Log('Deleted the ready marker of the previous setup: ' + Marker)
      else
        Log('Could not delete ' + Marker);
    end;
    if HasSwitch('/SKIPRUNTIME') then
      Log('/SKIPRUNTIME: skipping the component download; it runs the next time Keytrace is opened.')
    else
      RunComponentSetup;
  end;
end;

{ ---- uninstall ---- }

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

// runtime: the venv made by the setup window. Its pyvenv.cfg points to the python folder next to it.
function IsOurRuntime(const Dir: String): Boolean;
var
  Lines: TArrayOfString;
  I: Integer;
  Line, PythonDir: String;
begin
  Result := FileExists(Dir + '\midiconv-ready.txt');
  if Result then
    Exit;
  PythonDir := Lowercase(ExpandConstant('{app}\python\'));
  if LoadStringsFromFile(Dir + '\pyvenv.cfg', Lines) then
    for I := 0 to GetArrayLength(Lines) - 1 do
    begin
      Line := Lowercase(Trim(Lines[I]));
      if (Pos('home', Line) = 1) and (Pos(PythonDir, Line) > 0) then
      begin
        Result := True;
        Exit;
      end;
    end;
end;

// python: uv's managed Python (uv python install 3.13): a cpython-3.13 folder, or only uv's own files
// (.lock, .gitignore, .temp, .cache), which is what a failed or cancelled first download leaves.
function IsOurPython(const Dir: String): Boolean;
var
  FindRec: TFindRec;
  Name: String;
  HasPython, HasLock, OnlyUvFiles: Boolean;
begin
  HasPython := False;
  HasLock := False;
  OnlyUvFiles := True;
  if FindFirst(Dir + '\*', FindRec) then
  try
    repeat
      Name := Lowercase(FindRec.Name);
      if Pos('cpython-3.13', Name) = 1 then
        HasPython := True
      else if Name = '.lock' then
        HasLock := True
      else if (Name <> '.') and (Name <> '..') and (Name <> '.gitignore') and (Name <> '.temp') and (Name <> '.cache') then
        OnlyUvFiles := False;
    until not FindNext(FindRec);
  finally
    FindClose(FindRec);
  end;
  Result := HasPython or (HasLock and OnlyUvFiles);
end;

// .uv-cache: a uv cache (left behind only if the setup window was killed).
function IsOurUvCache(const Dir: String): Boolean;
begin
  Result := FileExists(Dir + '\CACHEDIR.TAG');
end;

procedure RemoveSetupFolder(const Name: String);
var
  Dir: String;
  Ours: Boolean;
begin
  Dir := ExpandConstant('{app}\') + Name;
  if not DirExists(Dir) then
    Exit;
  if Name = 'runtime' then
    Ours := IsOurRuntime(Dir)
  else if Name = 'python' then
    Ours := IsOurPython(Dir)
  else
    Ours := IsOurUvCache(Dir);
  if Ours then
    RemoveTree(Dir)
  else
    Log('Kept ' + Dir + ': it was not created by Keytrace''s setup.');
end;

{ User data: the app's folder, and MIDI Converter 0.1.0's folder, which the app moves to the new one when it
  first starts (a copy can leave it behind, and an install that was never opened again still has it). }
function UserDataDir: String;
begin
  Result := ExpandConstant('{localappdata}\{#AppName}');
end;

function LegacyUserDataDir: String;
begin
  Result := ExpandConstant('{localappdata}\{#LegacyName}');
end;

procedure DeleteUserDataDir(const Dir: String);
begin
  if not DirExists(Dir) then
    Exit;
  if DelTree(Dir, True, True, True) then
    Log('Deleted ' + Dir)
  else
    Log('Could not delete ' + Dir);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Folders: String;
begin
  if CurUninstallStep = usUninstall then
  begin
    { runtime first: its pyvenv.cfg is what identifies it, and it links into python. }
    RemoveSetupFolder('runtime');
    RemoveSetupFolder('python');
    RemoveSetupFolder('.uv-cache');
    RemoveTree(ExpandConstant('{app}\app\models\aria-amt'));
    DeleteUserData := False;
    Folders := '';
    if DirExists(UserDataDir) then
      Folders := Folders + #13#10 + UserDataDir;
    if DirExists(LegacyUserDataDir) then
      Folders := Folders + #13#10 + LegacyUserDataDir;
    if (Folders <> '') and not UninstallSilent then
      DeleteUserData := MsgBox('Do you also want to delete your Keytrace conversion history and settings?' + #13#10 +
                               Folders, mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
  end
  else if (CurUninstallStep = usPostUninstall) and DeleteUserData then
  begin
    DeleteUserDataDir(UserDataDir);
    DeleteUserDataDir(LegacyUserDataDir);
  end;
end;
