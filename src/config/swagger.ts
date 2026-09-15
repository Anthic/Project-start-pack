import swaggerJSDoc from "swagger-jsdoc";

const swaggerOptions: swaggerJSDoc.Options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Starter Pack API Documentation",
      version: "1.0.0",
      description: "OpenAPI documentation for the backend starter pack API",
    },
    servers: [
      {
        url: "http://localhost:8000/api/v1",
        description: "Development server",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
  },
  apis: ["./src/app/modules/**/*.routes.ts", "./src/app/routes/*.ts"],
};

export const swaggerDocs = swaggerJSDoc(swaggerOptions);
