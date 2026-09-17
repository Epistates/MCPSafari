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
                // StrictConcurrency is not listed: it is already on in Swift 6
                // language mode, which tools-version 6.3 selects, so naming it
                // here would be a line that reads like a decision and is not one.
                // These three are gated on Swift 7 and do change what compiles.
                .enableUpcomingFeature("ExistentialAny"),
                .enableUpcomingFeature("InternalImportsByDefault"),
                .enableUpcomingFeature("MemberImportVisibility"),
            ]
        ),
        .testTarget(
            name: "MCPSafariTests",
            dependencies: ["MCPSafari"]
        ),
    ]
)
