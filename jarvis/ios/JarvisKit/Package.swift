// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "JarvisKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "JarvisKit", targets: ["JarvisKit"])
    ],
    targets: [
        .target(name: "JarvisKit"),
        .testTarget(name: "JarvisKitTests", dependencies: ["JarvisKit"]),
    ]
)
