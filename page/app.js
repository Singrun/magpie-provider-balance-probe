const DEFAULT_OPTIONS = {
  display: true,
}

const displayInput = document.querySelector("#display-balance")
const saveState = document.querySelector("#save-state")

function render(display) {
  displayInput.checked = display
  saveState.textContent = display ? "已开启" : "已关闭"
}

async function loadOptions() {
  try {
    await magpie.ready
    const saved = await magpie.options.get()
    render(saved?.display === undefined ? DEFAULT_OPTIONS.display : Boolean(saved.display))
  } catch {
    render(DEFAULT_OPTIONS.display)
    saveState.textContent = "无法读取选项"
  }
}

displayInput.addEventListener("change", async () => {
  const display = displayInput.checked
  try {
    await magpie.options.set({ display })
    render(display)
  } catch {
    displayInput.checked = !display
    saveState.textContent = "保存失败"
  }
})

loadOptions()
