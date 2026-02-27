declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        role: "ADMIN" | "MEMBER";
        email: string;
        name: string;
        contactEmail: string | null;
        phoneNumber: string | null;
        personalId: string | null;
        readingPoints: number;
      };
    }
  }
}

export {};
