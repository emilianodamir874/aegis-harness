import type {
  LiveVoiceAvailabilityResponse_unstable,
  LiveVoiceStartResponse_unstable,
} from '@aaif/goose-acp-client';
import { getAcpClient } from './acpConnection';

export async function acpGetLiveVoiceAvailability(
  sessionId?: string
): Promise<LiveVoiceAvailabilityResponse_unstable> {
  const { aegis } = await getAcpClient();
  return aegis.sessionLiveVoiceAvailability_unstable(sessionId ? { sessionId } : {});
}

export async function acpStartLiveVoice(
  sessionId: string,
  offerSdp: string
): Promise<LiveVoiceStartResponse_unstable> {
  const { aegis } = await getAcpClient();
  return aegis.sessionLiveVoiceStart_unstable({
    sessionId,
    offerSdp,
  });
}

export async function acpStopLiveVoice(sessionId: string, interactionId: string): Promise<void> {
  const { aegis } = await getAcpClient();
  await aegis.sessionLiveVoiceStop_unstable({ sessionId, interactionId });
}
