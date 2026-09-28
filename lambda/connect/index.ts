import { APIGatewayProxyWebsocketHandlerV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE!;
const CONNECTION_TTL_SECONDS = 4 * 60 * 60; // 4h idle ceiling for a live connection

export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const ttl = Math.floor(Date.now() / 1000) + CONNECTION_TTL_SECONDS;

  await ddb.send(
    new PutCommand({
      TableName: CONNECTIONS_TABLE,
      Item: { connectionId, connectedAt: new Date().toISOString(), ttl },
    }),
  );

  return { statusCode: 200, body: 'connected' };
};
