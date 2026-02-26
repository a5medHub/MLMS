declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        role: "ADMIN" | "MEMBER";
        email: string;
        name: string;
      };
    }
  }
}

export {};
