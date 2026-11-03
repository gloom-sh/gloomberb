export interface CloudWorldVenuePayload {
  mic: string;
  name: string;
  title: string;
  country: string;
  countryCode: string;
  city: string;
  timezone: string;
  latitude: number;
  longitude: number;
  isOpen: boolean;
  timeAfterOpenSeconds?: number;
  timeToOpenSeconds?: number;
  timeToCloseSeconds?: number;
}

export interface CloudWorldVenueMapPayload {
  providerId: "gloomberb-cloud";
  checkedAt: number;
  refreshAt: number;
  stale?: boolean;
  venues: CloudWorldVenuePayload[];
}
