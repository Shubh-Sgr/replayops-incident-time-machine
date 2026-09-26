export interface DemoSessionIdentity {
  id: string;
  email: string;
}

export function encodeDemoSessionToken(identity: DemoSessionIdentity) {
  const payload = window.btoa(JSON.stringify({ id: identity.id, email: identity.email }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `demo-session.${payload}`;
}
