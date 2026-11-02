#ifndef AppVersion
#define AppVersion "0.0.0"
#endif

#ifndef Arch
#define Arch "x64"
#endif

#ifndef OutputDir
#define OutputDir "..\artifacts"
#endif

#ifndef SourceDir
#define SourceDir "..\build\stable-win-" + Arch + "\Gloom-inno-source\Gloom"
#endif

#if Arch == "arm64"
#define Architectures "arm64"
#else
#define Architectures "x64compatible"
#endif

[Setup]
AppId={{D7B2304C-840B-4E5F-956A-3D1C66E67B35}
AppName=Gloom
AppVersion={#AppVersion}
AppPublisher=Gloom
AppPublisherURL=https://gloom.sh
AppSupportURL=https://github.com/gloom-sh/gloomberb/issues
AppUpdatesURL=https://github.com/gloom-sh/gloomberb/releases
; Electrobun's folder for the app, the only one its updater updates. The app's
; first start there writes Electrobun's uninstaller, its Apps & features entry
; and its Start menu and Desktop shortcuts, so this setup leaves no uninstaller
; of its own: one in the app's folder would be gone after the first update.
; An install from an earlier setup, in Programs\Gloom or a folder the user
; picked, is uninstalled first. See PrepareToInstall.
DefaultDirName={localappdata}\com.vincelwt.gloomberb\stable\app
DisableDirPage=yes
UsePreviousAppDir=no
Uninstallable=no
DefaultGroupName=Gloom
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed={#Architectures}
ArchitecturesInstallIn64BitMode={#Architectures}
AppendDefaultDirName=no
OutputDir={#OutputDir}
OutputBaseFilename=GloomSetup
Compression=lzma2
SolidCompression=yes
SetupLogging=yes
SetupIconFile={#SourceDir}\Resources\gloomberb-logo.ico
WizardStyle=modern
ChangesEnvironment=yes

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; The app's folders hold one build, whole, as the updater leaves them.
Type: filesandordirs; Name: "{app}\bin"
Type: filesandordirs; Name: "{app}\Resources"
; Shortcuts an install from before the rename made under the old name.
Type: files; Name: "{autoprograms}\Gloomberb.lnk"
Type: files; Name: "{autodesktop}\Gloomberb.lnk"

; The app's first start makes Electrobun's shortcuts under the same name.
[Icons]
Name: "{autoprograms}\Gloom"; Filename: "{app}\bin\launcher.exe"; WorkingDir: "{app}\bin"; IconFilename: "{app}\Resources\gloomberb-logo.ico"

[Run]
Filename: "{app}\bin\launcher.exe"; Description: "Launch Gloom"; Flags: nowait postinstall skipifsilent; WorkingDir: "{app}\bin"

[Code]
const
  EnvironmentKey = 'Environment';
  PathValueName = 'Path';
  // Where an earlier setup recorded its install, under this AppId.
  UninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{D7B2304C-840B-4E5F-956A-3D1C66E67B35}_is1';

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

function SamePath(Left: string; Right: string): Boolean;
begin
  Result := (Left <> '') and (NormalizePathValue(Left) = NormalizePathValue(Right));
end;

// The folders an earlier setup installed into by default: they hold nothing of the user's.
function IsDefaultInstallDir(Dir: string): Boolean;
begin
  Result := SamePath(Dir, ExpandConstant('{localappdata}\Programs\Gloom')) or
    SamePath(Dir, ExpandConstant('{localappdata}\Programs\Gloomberb'));
end;

// An install from an earlier setup is uninstalled with its own uninstaller,
// which removes what it installed, its PATH entry and its shortcuts and keeps
// the user's own files in a folder they picked. Without one, its record and
// PATH entry go here, and its folder when it is a default one.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  PreviousDir: string;
  Uninstaller: string;
  ResultCode: Integer;
  Attempt: Integer;
begin
  Result := '';
  if not RegQueryStringValue(HKCU, UninstallKey, 'Inno Setup: App Path', PreviousDir) then
    Exit;
  if RegQueryStringValue(HKCU, UninstallKey, 'UninstallString', Uninstaller) then
  begin
    Uninstaller := RemoveQuotes(Uninstaller);
    if FileExists(Uninstaller) then
    begin
      Log('Uninstalling the earlier install in ' + PreviousDir);
      if not Exec(Uninstaller, '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
        Log('Could not run ' + Uninstaller);
      // It hands over to a copy of itself, which removes its record last.
      Attempt := 0;
      while RegKeyExists(HKCU, UninstallKey) and (Attempt < 240) do
      begin
        Sleep(500);
        Attempt := Attempt + 1;
      end;
    end;
  end;
  if RegKeyExists(HKCU, UninstallKey) then
  begin
    Log('Removing the record of the earlier install in ' + PreviousDir);
    RegDeleteKeyIncludingSubkeys(HKCU, UninstallKey);
    RemovePathEntryFor(AddBackslash(PreviousDir) + 'bin');
    if IsDefaultInstallDir(PreviousDir) and DirExists(PreviousDir) and not DelTree(PreviousDir, True, True, True) then
      Log('Could not remove the earlier install folder ' + PreviousDir);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    AddPathEntry();
end;
