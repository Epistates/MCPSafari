// swift-tools-version: 6.3

import PackageDescription

let package = Package(
    name: "MCPSafari",
    platforms: [
        .macOS("14.0"),
    ],
    dependencies: [
        .package(
            url: "https://github.com/modelcontextprotocol/swift-sdk.git",
            revision: "a0ae212ebf6eab5f754c3129608bc5557637e605"
        ),
        .package(url: "https://github.com/apple/swift-log.git", from: "1.5.0"),
    ],
    targets: [
        .executableTarget(
            name: "MCPSafari",
            dependencies: [
                .product(name: "MCP", package: "swift-sdk"),
                .product(name: "Logging", package: "swift-log"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]
        ),
        .testTarget(
            name: "MCPSafariTests",
            dependencies: ["MCPSafari"]
        ),
    ]
)
