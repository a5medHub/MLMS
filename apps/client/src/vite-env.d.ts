/// <reference types="vite/client" />

interface GoogleCredentialResponse {
  credential: string;
}

interface GoogleIdConfig {
  client_id: string;
  callback: (response: GoogleCredentialResponse) => void;
  ux_mode?: "popup" | "redirect";
}

interface GoogleAccountIdApi {
  initialize(config: GoogleIdConfig): void;
  renderButton(
    parent: HTMLElement,
    options: {
      type?: "standard" | "icon";
      theme?: "outline" | "filled_blue" | "filled_black";
      text?: "signin_with" | "signup_with" | "continue_with" | "signin";
      size?: "large" | "medium" | "small";
      shape?: "pill" | "rectangular" | "circle" | "square";
      logo_alignment?: "left" | "center";
      width?: number;
    }
  ): void;
}

interface Window {
  google?: {
    accounts: {
      id: GoogleAccountIdApi;
    };
  };
}
