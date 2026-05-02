FROM python:3.12-slim

LABEL description="Hermes MCP Gateway — MCP Server for Knot integration"

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy gateway code
COPY . ./mcp_gateway/

# Data directory
RUN mkdir -p /data/hermes-gateway
VOLUME /data/hermes-gateway

# Default environment
ENV HERMES_GATEWAY_HOST=0.0.0.0
ENV HERMES_GATEWAY_PORT=8080
ENV HERMES_GATEWAY_DATA=/data/hermes-gateway
ENV PYTHONUNBUFFERED=1

# HTTP API (8080) + MCP Server (8081)
EXPOSE 8080 8081

CMD ["python", "-m", "mcp_gateway"]
