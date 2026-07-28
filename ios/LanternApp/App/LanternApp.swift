import SwiftUI

@main
struct LanternApp: App {
    var body: some Scene {
        WindowGroup {
            LanternWebView()
                .ignoresSafeArea(.container, edges: .bottom)
        }
    }
}
