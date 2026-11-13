import dotenv from 'dotenv';
dotenv.config();

export const env = {
  port: Number(process.env.PORT || 4000),
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  // Convex deployment that holds all data (Nexus project). The secret must match the
  // NEXUS_SERVER_SECRET environment variable set on that Convex deployment.
  convexUrl: process.env.CONVEX_URL,
  convexSecret: process.env.NEXUS_SERVER_SECRET,
  jwtSecret: process.env.JWT_SECRET || 'dev-secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
};
