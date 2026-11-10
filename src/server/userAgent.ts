let agent = "SFHelper";

export function setAppVersion(version: string): void {
  agent = version ? `SFHelper/${version}` : "SFHelper";
}

export const userAgent = (): string => agent;
