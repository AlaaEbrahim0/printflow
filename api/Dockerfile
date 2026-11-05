FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY Directory.Build.props PrintSheet.slnx ./
COPY src/PrintSheet.Domain/PrintSheet.Domain.csproj src/PrintSheet.Domain/
COPY src/PrintSheet.Application/PrintSheet.Application.csproj src/PrintSheet.Application/
COPY src/PrintSheet.Infrastructure/PrintSheet.Infrastructure.csproj src/PrintSheet.Infrastructure/
COPY src/PrintSheet.Api/PrintSheet.Api.csproj src/PrintSheet.Api/
COPY tests/PrintSheet.Domain.Tests/PrintSheet.Domain.Tests.csproj tests/PrintSheet.Domain.Tests/
RUN dotnet restore PrintSheet.slnx

COPY . .
RUN dotnet publish src/PrintSheet.Api/PrintSheet.Api.csproj -c Release -o /app/publish --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/publish .
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
    CMD curl --fail --silent http://localhost:8080/healthz || exit 1
ENTRYPOINT ["dotnet", "PrintSheet.Api.dll"]
