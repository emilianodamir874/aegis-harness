import {
  client,
  methods,
  type Client,
  type ClientConnection,
  type Stream,
} from '@agentclientprotocol/sdk';
import {
  AEGIS_EXT_AGENT_REQUESTS,
  AEGIS_EXT_NOTIFICATIONS,
  AegisExtClient,
  type AegisSessionNotification_unstable,
  type ProviderDeviceCodeNotification_unstable,
  type RecipeParamsResponse_unstable,
  type RequestRecipeParams_unstable,
  zAegisSessionNotification_unstable,
  zProviderDeviceCodeNotification_unstable,
  zRequestRecipeParams_unstable,
} from '@aaif/goose-acp-client';

const [aegisSessionUpdate, providerDeviceCode] = AEGIS_EXT_NOTIFICATIONS;
const [aegisRecipeParamsRequest] = AEGIS_EXT_AGENT_REQUESTS;

export type AegisAcpCallbacks = Required<
  Pick<Client, 'requestPermission' | 'sessionUpdate' | 'createElicitation'>
> & {
  unstable_sessionRecipeRequestParams: (
    request: RequestRecipeParams_unstable
  ) => Promise<RecipeParamsResponse_unstable>;
  unstable_sessionUpdate: (notification: AegisSessionNotification_unstable) => Promise<void>;
  unstable_providerDeviceCode: (
    notification: ProviderDeviceCodeNotification_unstable
  ) => Promise<void>;
};

export type AegisAcpClient = {
  connection: ClientConnection;
  aegis: AegisExtClient;
};

export function connectAegisAcpClient(
  stream: Stream,
  callbacks: AegisAcpCallbacks
): AegisAcpClient {
  const app = client({ name: 'aegis' })
    .onRequest(methods.client.session.requestPermission, (context) =>
      callbacks.requestPermission(context.params)
    )
    .onNotification(methods.client.session.update, (context) =>
      callbacks.sessionUpdate(context.params)
    )
    .onRequest(methods.client.elicitation.create, (context) =>
      callbacks.createElicitation(context.params)
    )
    .onRequest(aegisRecipeParamsRequest.method, zRequestRecipeParams_unstable, (context) =>
      callbacks.unstable_sessionRecipeRequestParams(context.params)
    )
    .onNotification(aegisSessionUpdate.method, zAegisSessionNotification_unstable, (context) =>
      callbacks.unstable_sessionUpdate(context.params)
    )
    .onNotification(
      providerDeviceCode.method,
      zProviderDeviceCodeNotification_unstable,
      (context) => callbacks.unstable_providerDeviceCode(context.params)
    );

  const connection = app.connect(stream);
  const aegis = new AegisExtClient(connection.agent);

  return { connection, aegis };
}
