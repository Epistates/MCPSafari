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
            exact: "0.12.1"
        ),
        .package(url: "https://github.com/apple/swift-log.git", from: "1.14.0"),
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
