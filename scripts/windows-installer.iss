#ifndef AppVersion
#define AppVersion "0.0.0"
#endif

#ifndef OutputDir
#define OutputDir "..\artifacts"
#endif

#ifndef SourceDir
#define SourceDir "..\build\stable-win-x64\Gloom-inno-source\Gloom"
#endif

[Setup]
AppId={{D7B2304C-840B-4E5F-956A-3D1C66E67B35}
AppName=Gloom
AppVersion={#AppVersion}
AppPublisher=Gloom
AppPublisherURL=https://gloom.sh
AppSupportURL=https://github.com/gloom-sh/gloomberb/issues
AppUpdatesURL=https://github.com/gloom-sh/gloomberb/releases
; Programs\Gloom. An install in Programs\Gloomberb, the folder before the
; rename, moves there and its old folder and PATH entry go; one the user put
; anywhere else stays where it is. See DefaultInstallDir.
DefaultDirName={code:DefaultInstallDir}
UsePreviousAppDir=no
DefaultGroupName=Gloom
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
AppendDefaultDirName=no
OutputDir={#OutputDir}
OutputBaseFilename=GloomSetup
Compression=lzma2
SolidCompression=yes
SetupLogging=yes
SetupIconFile={#SourceDir}\Resources\gloomberb-logo.ico
UninstallDisplayIcon={app}\Resources\gloomberb-logo.ico
WizardStyle=modern
ChangesEnvironment=yes

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; Shortcuts an install from before the rename made under the old name.
Type: files; Name: "{autoprograms}\Gloomberb.lnk"
Type: files; Name: "{autodesktop}\Gloomberb.lnk"

[Icons]
Name: "{autoprograms}\Gloom"; Filename: "{app}\bin\launcher.exe"; WorkingDir: "{app}\bin"; IconFilename: "{app}\Resources\gloomberb-logo.ico"
Name: "{autodesktop}\Gloom"; Filename: "{app}\bin\launcher.exe"; WorkingDir: "{app}\bin"; IconFilename: "{app}\Resources\gloomberb-logo.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\bin\launcher.exe"; Description: "Launch Gloom"; Flags: nowait postinstall skipifsilent; WorkingDir: "{app}\bin"

[Code]
const
  EnvironmentKey = 'Environment';
  PathValueName = 'Path';
  // Where Setup records this app's install, under its AppId.
  UninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{D7B2304C-840B-4E5F-956A-3D1C66E67B35}_is1';

var
  // The folder of the install this one replaces, read before Setup records the new one.
  PreviousInstallDir: string;

function PathEntry(): string;
begin
  Result := ExpandConstant('{app}\bin');
end;

function NormalizePathValue(Value: string): string;
begin
  Result := Lowercase(Value);
  StringChangeEx(Result, '"', '', True);
  while (Length(Result) > 0) and ((Result[Length(Result)] = '\') or (Result[Length(Result)] = '/')) do
    Delete(Result, Length(Result), 1);
end;

function PathContainsEntry(PathValue: string; Entry: string): Boolean;
var
  Rest: string;
  Part: string;
  SeparatorPosition: Integer;
  NormalizedEntry: string;
begin
  Result := False;
  NormalizedEntry := NormalizePathValue(Entry);

  Rest := PathValue;
  while Rest <> '' do
  begin
    SeparatorPosition := Pos(';', Rest);
    if SeparatorPosition = 0 then
    begin
      Part := Rest;
      Rest := '';
    end
    else
    begin
      Part := Copy(Rest, 1, SeparatorPosition - 1);
      Delete(Rest, 1, SeparatorPosition);
    end;

    if NormalizePathValue(Trim(Part)) = NormalizedEntry then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

procedure AddPathEntry();
var
  PathValue: string;
  Entry: string;
begin
  Entry := PathEntry();
  if not RegQueryStringValue(HKCU, EnvironmentKey, PathValueName, PathValue) then
    PathValue := '';

  if PathContainsEntry(PathValue, Entry) then
    Exit;

  if PathValue = '' then
    PathValue := Entry
  else
    PathValue := PathValue + ';' + Entry;

  RegWriteStringValue(HKCU, EnvironmentKey, PathValueName, PathValue);
end;

procedure RemovePathEntryFor(Entry: string);
var
  PathValue: string;
  Rest: string;
  Part: string;
  SeparatorPosition: Integer;
  NormalizedEntry: string;
  NextPath: string;
begin
  NormalizedEntry := NormalizePathValue(Entry);
  if not RegQueryStringValue(HKCU, EnvironmentKey, PathValueName, PathValue) then
    Exit;

  Rest := PathValue;
  NextPath := '';
  while Rest <> '' do
  begin
    SeparatorPosition := Pos(';', Rest);
    if SeparatorPosition = 0 then
    begin
      Part := Rest;
      Rest := '';
    end
    else
    begin
      Part := Copy(Rest, 1, SeparatorPosition - 1);
      Delete(Rest, 1, SeparatorPosition);
    end;

    Part := Trim(Part);
    if NormalizePathValue(Part) = NormalizedEntry then
      Continue;

    if Part = '' then
      Continue;

    if NextPath = '' then
      NextPath := Part
    else
      NextPath := NextPath + ';' + Part;
  end;

  RegWriteStringValue(HKCU, EnvironmentKey, PathValueName, NextPath);
end;

procedure RemovePathEntry();
begin
  RemovePathEntryFor(PathEntry());
end;

function SamePath(Left: string; Right: string): Boolean;
begin
  Result := (Left <> '') and (NormalizePathValue(Left) = NormalizePathValue(Right));
end;

// The default folder before the rename.
function LegacyInstallDir(): string;
begin
  Result := ExpandConstant('{localappdata}\Programs\Gloomberb');
end;

function RecordedInstallDir(): string;
begin
  if not RegQueryStringValue(HKCU, UninstallKey, 'Inno Setup: App Path', Result) then
    Result := '';
end;

function DefaultInstallDir(Param: string): string;
var
  Previous: string;
begin
  Previous := RecordedInstallDir();
  if (Previous <> '') and not SamePath(Previous, LegacyInstallDir()) then
    Result := Previous
  else
    Result := ExpandConstant('{localappdata}\Programs\Gloom');
end;

function MovesFromLegacyInstallDir(): Boolean;
begin
  Result := SamePath(PreviousInstallDir, LegacyInstallDir()) and not SamePath(ExpandConstant('{app}'), LegacyInstallDir());
end;

function InitializeSetup(): Boolean;
begin
  PreviousInstallDir := RecordedInstallDir();
  Result := True;
end;

// The app running from the old folder is closed like one running from {app}.
procedure RegisterExtraCloseApplicationsResources();
begin
  if not MovesFromLegacyInstallDir() then
    Exit;
  if FileExists(LegacyInstallDir() + '\bin\launcher.exe') then
    RegisterExtraCloseApplicationsResource(False, LegacyInstallDir() + '\bin\launcher.exe');
  if FileExists(LegacyInstallDir() + '\bin\bun.exe') then
    RegisterExtraCloseApplicationsResource(False, LegacyInstallDir() + '\bin\bun.exe');
end;

// After the app is in its new folder: the old folder and its PATH entry go.
procedure RemoveLegacyInstall();
begin
  if not MovesFromLegacyInstallDir() then
    Exit;
  RemovePathEntryFor(LegacyInstallDir() + '\bin');
  if DirExists(LegacyInstallDir()) and not DelTree(LegacyInstallDir(), True, True, True) then
    Log('Could not remove the previous install folder ' + LegacyInstallDir());
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    AddPathEntry();
    RemoveLegacyInstall();
  end;
end;

// The list in which updates from inside the app name every file they put in
// its folder (installer-folder.ts): this uninstaller removes only the files it
// installed itself.
function UpdateFileList(): string;
begin
  Result := ExpandConstant('{app}\Resources\update-files.txt');
end;

// A path from that list: relative, and inside the app's folder.
function IsInsideApp(Path: string): Boolean;
begin
  if Path = '' then
    Result := False
  else
    Result := (Pos(':', Path) = 0) and (Pos('..', Path) = 0) and (Path[1] <> '\') and (Path[1] <> '/');
end;

// The folders above Path, inside the app's folder, that it leaves empty.
procedure RemoveEmptyFoldersAbove(Path: string);
var
  Folder: string;
begin
  Folder := ExtractFileDir(Path);
  while Length(Folder) > Length(ExpandConstant('{app}')) do
  begin
    if not RemoveDir(Folder) then
      Exit;
    Folder := ExtractFileDir(Folder);
  end;
end;

// What updates added: the files they list, and what a move into this folder
// that did not finish left (.gloom-next-*, .gloom-previous-*). A file they do
// not list stays, and so does the folder holding it: one the user picked can
// hold their own files, in its bin as well.
procedure RemoveFilesAddedByUpdates();
var
  Files: TArrayOfString;
  Path: string;
  I: Integer;
begin
  if not DirExists(ExpandConstant('{app}')) then
    Exit;
  if LoadStringsFromFile(UpdateFileList(), Files) then
  begin
    for I := 0 to GetArrayLength(Files) - 1 do
    begin
      Path := Trim(Files[I]);
      if IsInsideApp(Path) then
      begin
        DeleteFile(ExpandConstant('{app}\') + Path);
        RemoveEmptyFoldersAbove(ExpandConstant('{app}\') + Path);
      end;
    end;
    DeleteFile(UpdateFileList());
    RemoveEmptyFoldersAbove(UpdateFileList());
  end;
  DelTree(ExpandConstant('{app}\.gloom-next-*'), False, True, True);
  DelTree(ExpandConstant('{app}\.gloom-previous-*'), False, True, True);
  RemoveDir(ExpandConstant('{app}'));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    RemovePathEntry();
    RemoveFilesAddedByUpdates();
  end;
end;
