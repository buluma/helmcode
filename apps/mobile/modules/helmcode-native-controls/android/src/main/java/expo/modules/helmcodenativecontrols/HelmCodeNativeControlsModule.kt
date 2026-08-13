package expo.modules.helmcodenativecontrols

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HelmCodeNativeControlsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HelmCodeNativeControls")

    Function("getShowcasePairingUrl") {
      appContext.currentActivity?.intent?.getStringExtra("showcasePairingUrl")
    }

    Function("getShowcaseScene") {
      val storedScene = appContext.reactContext
        ?.filesDir
        ?.resolve("helmcode-showcase-scene")
        ?.takeIf { it.isFile }
        ?.readText()
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
      storedScene ?: appContext.currentActivity?.intent?.getStringExtra("showcaseScene")
    }

    Function("prepareShowcaseCapture") {
      // Android app data is cleared by the host runner before launch.
    }

    Function("markShowcaseReady") { scene: String ->
      appContext.reactContext
        ?.filesDir
        ?.resolve("helmcode-showcase-ready")
        ?.writeText(scene)
    }

    View(HelmCodeHeaderButtonView::class) {
      Prop("label") { view: HelmCodeHeaderButtonView, label: String ->
        view.setLabel(label)
      }
      Prop("systemImage") { view: HelmCodeHeaderButtonView, systemImage: String ->
        view.setSystemImage(systemImage)
      }

      Events("onTriggered")
    }
  }
}
