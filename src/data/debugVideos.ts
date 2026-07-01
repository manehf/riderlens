import type { VideoLinkProvider } from "../types/domain";

export type DebugVideoReference = {
  id: string;
  title: string;
  url: string;
  provider: VideoLinkProvider;
  skillType: "regular_jump";
  notes: string;
};

export const debugVideoReferences: DebugVideoReference[] = [
  {
    id: "debug-regular-jump-l4p7lkupdw0",
    title: "Regular jump debug reference",
    url: "https://www.youtube.com/watch?v=l4p7LkUpdW0",
    provider: "youtube",
    skillType: "regular_jump",
    notes: "Saved debug link for UI and library testing. Upload the original clip file for MediaPipe frame analysis."
  }
];
