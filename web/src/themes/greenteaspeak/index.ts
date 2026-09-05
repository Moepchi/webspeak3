export const GREENTEASPEAK_THEME_ID = "greenteaspeak" as const;

export function isGreenteaSpeakTheme(theme: string): boolean {
  return theme === GREENTEASPEAK_THEME_ID;
}

export {
  GreenteaSpeakChrome,
  type GreenteaSpeakChromeProps,
  type ConnectionTabItem,
} from "./GreenteaSpeakChrome";

export {
  buildGatewayConnect,
  sendGatewayAction,
  type GatewayConnectPayload,
  type GatewayOutboundAction,
  type GatewayServerType,
} from "./gatewayAdapter";
