#ifndef MyAppVersion
#define MyAppVersion "0.1.0"
#endif

#define MyAppName "TreeNote"
#define MyAppExeName "treenote.exe"

[Setup]
AppId={{8F4E2B91-6C3D-4A17-9E52-1D7B8A4F0C63}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=ldbiz
DefaultDirName={localappdata}\Programs\TreeNote
DefaultGroupName=TreeNote
DisableDirPage=no
DisableProgramGroupPage=no
OutputDir=..\dist\installer
OutputBaseFilename=treenote-{#MyAppVersion}-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
UninstallDisplayIcon={app}\{#MyAppExeName}

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
Source: "..\dist\treenote\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\TreeNote"; Filename: "{app}\{#MyAppExeName}"
Name: "{userdesktop}\TreeNote"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\TreeNote"; ValueType: string; ValueName: "DataRoot"; ValueData: "{code:GetDataRoot}"
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "TreeNote"; Flags: dontcreatekey uninsdeletevalue
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"; ValueType: none; ValueName: "TreeNote"; Flags: dontcreatekey uninsdeletevalue

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch TreeNote"; Flags: nowait postinstall skipifsilent

[Code]
var
  DataRootPage: TInputDirWizardPage;
  ExistingDataRoot: String;
  DataRootPageShown: Boolean;

function DefaultDataRoot: String;
begin
  Result := ExpandConstant('{userappdata}\treenote');
end;

function GetDataRoot(Param: String): String;
begin
  if ExistingDataRoot <> '' then
    Result := ExistingDataRoot
  else if Assigned(DataRootPage) then
  begin
    Result := Trim(DataRootPage.Values[0]);
    if Result = '' then
      Result := DefaultDataRoot;
  end
  else
    Result := DefaultDataRoot;
end;

function ProbeDataRootWritable(const Root: String): Boolean;
var
  Probe: String;
begin
  Result := False;
  Probe := AddBackslash(Root) + '.treenote-write-probe';
  if not SaveStringToFile(Probe, 'ok', False) then
    Exit;
  if not DeleteFile(Probe) then
    Exit;
  Result := True;
end;

procedure InitializeWizard;
begin
  ExistingDataRoot := '';
  DataRootPageShown := False;
  if RegQueryStringValue(HKCU, 'Software\TreeNote', 'DataRoot', ExistingDataRoot) then
    ExistingDataRoot := Trim(ExistingDataRoot);
  if ExistingDataRoot <> '' then
    Exit;

  DataRootPage := CreateInputDirPage(
    wpSelectDir,
    'TreeNote data folder',
    'Choose the folder TreeNote uses for settings, notebooks and backups.',
    'The default is TreeNote''s AppData folder. This cannot be changed later without moving the data yourself.',
    False,
    '');
  DataRootPage.Add('Data folder:');
  DataRootPage.Values[0] := DefaultDataRoot;
  DataRootPageShown := True;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Root: String;
begin
  Result := True;
  if not DataRootPageShown then
    Exit;
  if CurPageID <> DataRootPage.ID then
    Exit;
  Root := GetDataRoot('');
  if not ForceDirectories(Root) then
  begin
    MsgBox('TreeNote could not create the data folder:'#13#10 + Root, mbError, MB_OK);
    Result := False;
    Exit;
  end;
  if not ProbeDataRootWritable(Root) then
  begin
    MsgBox('TreeNote cannot write to the selected data folder:'#13#10 + Root, mbError, MB_OK);
    Result := False;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Root: String;
begin
  Result := '';
  NeedsRestart := False;
  if ExistingDataRoot <> '' then
    Exit;
  Root := GetDataRoot('');
  if not ForceDirectories(Root) then
  begin
    Result := 'TreeNote could not create the data folder:'#13#10 + Root;
    Exit;
  end;
  if not ProbeDataRootWritable(Root) then
    Result := 'TreeNote cannot write to the selected data folder:'#13#10 + Root;
end;
