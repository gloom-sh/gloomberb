#ifndef AppVersion
#define AppVersion "0.0.0"
#endif

#ifndef OutputDir
#define OutputDir "..\artifacts"
#endif

#ifndef SourceDir
#define SourceDir "..\build\stable-win-x64\Gloomberb-inno-source\Gloomberb"
#endif

[Setup]
AppId={{D7B2304C-840B-4E5F-956A-3D1C66E67B35}
AppName=Gloomberb
AppVersion={#AppVersion}
AppPublisher=Gloomberb
AppPublisherURL=https://gloomberb.com
AppSupportURL=https://github.com/gloom-sh/gloomberb/issues
AppUpdatesURL=https://github.com/gloom-sh/gloomberb/releases
DefaultDirName={localappdata}\Programs\Gloomberb
DefaultGroupName=Gloomberb
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
AppendDefaultDirName=no
OutputDir={#OutputDir}
OutputBaseFilename=GloomberbSetup
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

[Icons]
Name: "{autoprograms}\Gloomberb"; Filename: "{app}\bin\launcher.exe"; WorkingDir: "{app}\bin"; IconFilename: "{app}\Resources\gloomberb-logo.ico"
Name: "{autodesktop}\Gloomberb"; Filename: "{app}\bin\launcher.exe"; WorkingDir: "{app}\bin"; IconFilename: "{app}\Resources\gloomberb-logo.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\bin\launcher.exe"; Description: "Launch Gloomberb"; Flags: nowait postinstall skipifsilent; WorkingDir: "{app}\bin"

[Code]
const
  EnvironmentKey = 'Environment';
  PathValueName = 'Path';

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

procedure RemovePathEntry();
var
  PathValue: string;
  Entry: string;
  Rest: string;
  Part: string;
  SeparatorPosition: Integer;
  NormalizedEntry: string;
  NextPath: string;
begin
  Entry := PathEntry();
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

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    AddPathEntry();
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    RemovePathEntry();
end;
